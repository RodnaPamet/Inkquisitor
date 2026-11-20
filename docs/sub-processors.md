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
