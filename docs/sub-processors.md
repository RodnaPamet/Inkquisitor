# Sub-processors (draft)

> **Status: internal draft, not published.** The public sub-processor list and
> privacy page arrive with Phase 7 (`docs/ROADMAP.md`, Phase 7). This draft is
> where the facts are kept until then; every change that sends data to a new
> party updates it in the same pull request. It is not on the help site
> (`site/manifest.json` publishes `docs/user/` only).

Who receives an author's data when they use Inkquisitor, what they receive,
and under which terms. "Author text" is everything an author writes: the
bible, interview answers, research briefs, and (from Phase 5) the manuscript.

## Model provider

| Party | What it receives | When | Terms |
|---|---|---|---|
| Anthropic (Claude API, Messages endpoint only) | Author text in fenced data blocks; the product's own prompts; the model's answers | Every model feature: interview questions (2.2; since 4.0 with the author's confirmed source facts and relevant passages of their own drafts as context; since 4.2 a "grill me on what changed" session also carries the upstream entry before and after its change; since 4.3 a session started from a stress test also carries its weak points' labels and questions), rephrasing (2.4), enrichment (2.5), research findings and fit (2.6), source fact extraction (4.0: each passage of an uploaded draft, its headings and the book's element names), bible fact extraction (4.1: the text of each accepted bible entry that changed, automatically, with the facts already recorded about it and the book's element names; since 4.2 also the book's open promises, clues and open questions, so it can propose new ones and say one was paid off), the nightly continuity check (4.2: the statements of a changed book's recorded facts, with their subjects' names, story times and places in the story order, automatically, every night), the stress test (4.3: on the author's confirmation, the book's title and logline, its elements' names and summaries, the story order, its top facts, open threads and the most relevant passages of its drafts, bounded), the gap ranking (4.3: on the author's confirmation, the names of the bible's field labels and counts of how empty they are, with the book's title, logline and its elements' names and summaries, bounded), and the summary of a long interview's earlier rounds (4.3, off by default: those rounds' questions and answers) | Zero data retention (`AI_RETENTION_MODE=zdr`, an organisation arrangement with Anthropic) is the launch gate; standard retention (`standard-beta`) only during the closed beta (decision D5, amended 2026-11-19). Output JSON schemas are code and carry no author text (Anthropic caches schemas outside zero retention). |

The messages-only middleware (`src/lib/ai/client.ts`) refuses every other
Anthropic surface (files, batches, message threads, containers, MCP, beta
headers), so nothing is stored at Anthropic on the product's behalf beyond the
Messages call itself.

## Source fact extraction (Phase 4.0, decisions D23 and D26)

Reading facts from an uploaded source sends **every passage** of it (about
1–2k tokens each, with its chapter headings and, for a book's library, the
book's element names) to Anthropic, one fast-tier call per passage, under the
same retention mode as every model call. It happens only after the author has
seen the estimated cost and confirmed it, per source; uploading alone sends
nothing. The uploaded file is never stored (only its extracted passages,
encrypted at rest in PostgreSQL); the passages' embeddings are made inside
the deployment (the 2.0 embedding provider), never by an external service.

## Bible fact extraction (Phase 4.1, decision D27)

When the author saves a change to their bible — an element or a relation,
by hand, by accepting a proposal, by import or by restore — the **text of the
entry that changed** is sent to Anthropic **automatically**, with no further
act of the author's: one fast-tier call per saved entry, or several over pieces of at
most 20,000 characters when a changed section is longer (a run of saves of one
entry is read once, at its newest version), carrying the entry's name and kind
and the sections that changed since it was last read, the facts already
recorded about it, and the book's element names. It runs in a background job,
under the same retention mode as every model call, and stops cleanly at the
workspace's monthly ceiling (D10) and at the kill switch (`AI_DISABLED=1`);
it is charged to the workspace's model-call minute (D17). In production it
runs only once a real-model evaluation record is committed (D11). Nothing is
stored at Anthropic beyond the Messages call; the facts are stored encrypted
in PostgreSQL. The embeddings of elements, facts and answers are made inside
the deployment (the 2.0 embedding provider), never by an external service.

## The nightly continuity check (Phase 4.2, decision D28)

Every night, with no act of the author's, each book whose bible changed since
its last check has its **recorded facts** sent to Anthropic: at most two
deep-tier calls a book a night, each carrying at most a hundred facts — each
fact's statement, its subject's name, its story time and its place in the
story order, with the names of the placed elements in that order — so the model
can name the pairs that cannot both be true. A large book is covered over
several nights. The calls run in a background job, under the same retention
mode as every model call, stop cleanly (and resume the next night) at the
workspace's monthly ceiling (D10) and at the kill switch (`AI_DISABLED=1`), and
are charged to the workspace's model-call minute (D17); in production they run
only once a real-model evaluation record is committed (D11). The model's
answer is numbers and a code (which pairs, of what kind), never text; nothing
is stored at Anthropic beyond the Messages call, and the proposed
contradictions are stored in PostgreSQL for the author to decide.

Since 4.2 the bible fact extraction (above) also carries the book's **open
promises, clues and open questions** (their titles, at most twenty), so it can
propose new ones and say that one was paid off; no call is added for them.

## Book-level interrogation (Phase 4.3, decision D29)

Three calls are added, each a Messages call under the same retention mode as
every model call, under the workspace's monthly ceiling (D10) and the kill
switch (`AI_DISABLED=1`), charged to the model-call minute (D17), and in
production run only once a real-model evaluation record is committed (D11).
None runs without an act of the author's.

- **The stress test** sends, once the author has confirmed its cost, the book's
  title and logline, its elements' names and summaries, the story order, its
  most relevant recorded facts, its open promises, clues and open questions,
  and the most relevant passages of its own drafts, together bounded to about
  forty thousand characters (one deep-tier call). The answer is short labels and
  questions citing what they rest on; they are stored encrypted in PostgreSQL
  and nothing is written to the bible.
- **The gap ranking** sends, when the author asks for it, a list of up to
  twelve empty bible fields (each a field label, its kind's label and counts:
  how many elements leave it empty, how many fields depend on it, the kind's
  relations, facts and citing entries) with the book's title and logline and its
  elements' names and the start of their summaries, bounded (one balanced-tier
  call). The answer is the order and one sentence a
  pick, stored encrypted.
- **Compaction** (off by default until Phase 4.4) sends a long interview's
  earlier rounds — their questions and answers — for a short summary (one
  fast-tier call); the summary is stored encrypted and travels beside the
  answers, which are still sent verbatim.

## Research: web search and web fetch (Phase 2.6, decision D9)

The research agent uses Anthropic's **server-side** web search and web fetch
tools (`web_search_20260209`, `web_fetch_20260209`, with dynamic filtering
off: `allowed_callers: ["direct"]`).

| Party | What it receives | Notes |
|---|---|---|
| Anthropic | The research brief (question, purpose, attached URLs) in the gather request; the search queries and fetch URLs the model writes | Under the same retention mode as every model call. |
| Anthropic's web search provider (a party Anthropic engages to run searches; not named in Anthropic's web search documentation as read 2026-11-20 — to be confirmed against Anthropic's own sub-processor list before launch) | The **search queries** | Queries are written from the research brief and carry **no manuscript or bible text**: the gather request holds the brief and nothing else of the book, the brief is refused if it repeats the book's stored text, and every query is checked against the book's text as it arrives (a quoting query stops the run). See "Honest limits" below. |
| The publishers of the pages fetched | The **page URLs** (and request metadata) | Anthropic's documentation: "website publishers might retain request data (such as fetched URLs and request metadata) according to their own policies". A URL can only be fetched if it appeared in the conversation (the brief's URLs, or a search or fetch result), and every fetch URL passes the same egress check, its host included (a host name reaches the resolver and the site as surely as a path does). |

**Attached files** (plain text or Markdown, virus-scanned, stored encrypted)
are read only by the findings step, as fenced data, and never by the gather
turn: their text reaches Anthropic, never the search provider.

### Zero-retention status of the web tools

From Anthropic's documentation, read 2026-11-20:

- **Web search** and **web fetch** are eligible for zero data retention, **excluding Covered Models** (the Fable and Mythos families, which require 30-day retention). The research run uses the balanced tier (Claude Sonnet 5.5), which is not a Covered Model.
- **Dynamic filtering** (the `_20260209` default, which runs the tools from code execution) is **not** zero-retention eligible. The product turns it off (`allowed_callers: ["direct"]`), and the middleware refuses a web tool definition without that setting.
- Even in a zero-retention configuration, **website publishers may retain the URLs fetched** and request metadata under their own policies.
- The search provider's own retention of queries is outside Anthropic's zero-retention terms as documented; this is why queries must carry no author text.

### Zero-retention settings, as configured (Phase 2.H)

Zero data retention is an arrangement Anthropic makes for an organisation;
no request member asks for it. What the product can configure, it does, and
each setting is held by code and a test:

| Setting | Where | What it does |
|---|---|---|
| A declared retention mode | `AI_RETENTION_MODE` (`zdr` or `standard-beta`), `src/lib/ai/config.ts` | Production refuses to start holding a key with neither. `standard-beta` (the closed beta only, decision D5 as amended) logs a WARN at every start of the web tier and the worker. `zdr` is the launch gate. |
| Only ZDR-eligible models under `zdr` | `ZDR_ELIGIBLE`, `src/lib/ai/model-capabilities.ts` | With `AI_RETENTION_MODE=zdr`, a tier override (`AI_MODEL_FAST` / `_BALANCED` / `_DEEP`) naming a Fable model (a Covered Model, 30-day retention required) or a model the capability table has no row for refuses to start. The three defaults are eligible. |
| Messages calls only | the middleware in `src/lib/ai/client.ts` | No Batches, Files, message threads, containers, MCP servers, context management, `metadata` or beta header ever leaves: the surfaces zero retention does not cover are refused, not merely unused. |
| Web tools without dynamic filtering | `SERVER_TOOL_SHAPES`, `src/lib/ai/client.ts` | `allowed_callers: ["direct"]` on both web tools; a definition without it is refused. |
| No author text in an output schema | `jsonSchemaFor` and the feature schemas | Schemas are code; Anthropic caches a compiled schema for up to 24 hours outside zero retention. |
| Prompt caching of the static system prompt only | `src/lib/ai/prompt.ts` | The default five-minute ephemeral cache, on the system block, which holds no author text. |
| The SDK's own telemetry | `clientForRun` | Pinned to `metadata_only`, with no propagation. |

Kept as it is (decision D5): the closed beta may run under standard retention
with the operator's explicit `standard-beta` flag.

### What a run lists (decision D15)

Every run lists, on its result page, **every search query and fetched URL it
sent**, in order and exactly as the model wrote it, a query the per-query check
refused included and marked. Each is stored as the response stream delivers it
(`ResearchEgress`: encrypted at rest, sanitised, workspace row-level security,
at most 100 a run, with any more counted and said), shown as plain text (never
a link), readable by every member who reads the bible, and deleted with its
run, its book and its workspace. So what left is never a matter of trust: the
author can read it.

### Honest limits

Anthropic runs a server tool itself, inside the API call: the product sees a
query only as the response streams it, and the API offers no hook to approve a
server tool call before it runs. So the per-query check is a **tripwire**
(it stops the run and records it), not a gate. The guarantee rests on the
gather request holding no bible or manuscript text to quote, and on the brief
itself being refused when it repeats the book (decision D15). A brief's own
words (the question and purpose the author writes for this purpose) do reach
the search provider, and the run's result page lists every query and URL that
actually left.

## Other services

| Party | What it receives | When |
|---|---|---|
| Sentry (optional, `SENTRY_DSN`) | Error reports: codes, ids, stack frames; never author text (`src/lib/observability/redaction.ts`) | Errors, when configured |
| Upstash (optional) | Rate-limit counters keyed by a masked client address | When both Upstash variables are set |
| S3-compatible storage (optional) | Uploaded files (none today: an import is read and never stored, a research file's text and a source's passages are stored encrypted in PostgreSQL) | When `STORAGE_PROVIDER=s3` |
| Have I Been Pwned (optional) | The first five characters of a password's SHA-1 hash (k-anonymity) | Sign-up, unless `PASSWORD_BREACH_CHECK=off` |
| Google (optional) | Sign-in identity | When Google sign-in is configured |
| tldraw (tldraw Inc., `cdn.tldraw.com`) | One request for its watermark-tracking image (`TLDRAW_WATERMARK_TRACK_URL`, `src/lib/security/csp.ts`): the visitor's **IP address** and the product's **domain name** (the `Referer`, cut to the origin by `Referrer-Policy`), and the browser's ordinary request headers. **No author text, map content or account data**: the request is a fixed URL with no query. The CSP admits that one URL in `connect-src` and nothing else of the host (decision D20); fonts, icons and the translation are served from our own origin | Each time a story map opens on an https deployment (tldraw's licence manager, since tldraw 3.x is used unlicensed with its watermark, D1) |

Embeddings are computed in the deployment (self-hosted TEI, subphase 2.0): no
external embedding provider receives author text.

## Privacy page draft (research)

What the Phase 7 privacy page says about research, drafted with 2.6:

- Research runs only when an author starts it, on a brief they write.
- The brief's question, purpose and links go to Anthropic, and the search
  queries the model writes from them go to Anthropic's search provider. The
  book's bible and manuscript are not sent with that step, and a brief that
  repeats them is refused.
- Pages are fetched by Anthropic from their publishers, who may keep the
  addresses requested. Attached files go to Anthropic only.
- Every run lists every search query and page address it sent, exactly as
  sent, on its result page: the author can see what left.
- Nothing found reaches the bible until the author accepts it; every accepted
  change records the findings and sources it came from.
