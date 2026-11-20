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
| Anthropic (Claude API, Messages endpoint only) | Author text in fenced data blocks; the product's own prompts; the model's answers | Every model feature: interview questions (2.2), rephrasing (2.4), enrichment (2.5), research findings and fit (2.6) | Zero data retention (`AI_RETENTION_MODE=zdr`, an organisation arrangement with Anthropic) is the launch gate; standard retention (`standard-beta`) only during the closed beta (decision D5, amended 2026-11-19). Output JSON schemas are code and carry no author text (Anthropic caches schemas outside zero retention). |

The messages-only middleware (`src/lib/ai/client.ts`) refuses every other
Anthropic surface (files, batches, message threads, containers, MCP, beta
headers), so nothing is stored at Anthropic on the product's behalf beyond the
Messages call itself.

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
| S3-compatible storage (optional) | Uploaded files (none today: an import is read and never stored, and a research file's text is stored encrypted in PostgreSQL) | When `STORAGE_PROVIDER=s3` |
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
