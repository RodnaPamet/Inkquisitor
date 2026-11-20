# Inkquisitor — product roadmap

*Written 2026-11-18. Status: proposal, nothing built yet.*

Inkquisitor takes an author from a book concept to publishing readiness by **reverse prompting**: the product asks, the author answers. Every book element (plot, characters, setting, theme, mood, texture, prose style, and so on) has a **bible entry**. Clicking **Enrich** on an entry starts an interview about it, and the answers are folded back into the bible as changes the author accepts or rejects. The author sets how deep, how detailed and in what manner the questions come.

It is a spin-off of inflect-compliance: the UI platform, the tldraw canvas pattern, the model-call seam and the SaaS foundations are carved out of that repository rather than rebuilt.

## 1. Research findings

### 1.1 What inflect-compliance gives us

| Component (path in inflect-compliance) | Verdict | Note |
|---|---|---|
| `packages/ui` (`@inflect/ui`, ~25k lines) | Lift as-is | Already product-neutral, ships a token contract |
| `src/components/ui` primitives: DataTable, filter, Modal, Sheet, Combobox, FormField, Tooltip, date picker, undo toast | Lift with edits | Drop domain charts and builders |
| Layout shells: `EntityListPage`, `EntityDetailLayout`, `ListPageShell`, `DashboardLayout`, `AppShell` | Lift with edits | Rebind from tenant/org context to workspace |
| `src/styles/tokens.css`, Tailwind 4 config, `ThemeProvider` | Lift with edits | Rebrand the palette |
| `RichTextEditor.tsx` (TipTap 3) + `sanitize.ts` | Lift as-is | The bible-entry editor |
| `VersionDiff.tsx` + the `PolicyVersion` model | Lift with edits | Becomes `BibleEntryVersion` |
| tldraw canvas: `components/processes/tldraw/` (custom shape, binding, serializer), autosave, snapshots, history sidebar, diff overlay, `canvas-auto-layout.ts` | Lift with edits | Rows are the source of truth, tldraw is a view. Strip the compliance node taxonomy |
| AI guard scanners (`app-layer/ai/guard`: patterns, normalize, injection, egress) | Lift as-is | ~1.2k pure lines; rewrite only the wrapper |
| `tool-runner/client.ts` (`clientForRun`) + ESLint rule `anthropic-client-single-seam` | Lift with edits | One file loads the SDK; drop residency branches |
| Assistant `tool-loop.ts`, `stream-events.ts`, SSE route, `use-assistant-stream.ts` | Lift with edits | Replace the raw-fetch provider with SDK streaming to get token streaming |
| Skill mount system (`flue/skills`: `SKILL.md` folders, hash pinning, text scan, evaluation records) | Lift with edits | Becomes the interviewer-pack library |
| AI decision log, `assistant/spend-ceiling.ts` | Lift with edits | Per-call record and per-user spend cap |
| Questionnaire / self-assessment models | Borrow the shape | Session → question → answer, and "AI draft, human accept". All existing banks are static; none generates the next question |
| Auth (next-auth 4, Credentials + Google) | Lift with edits | Drop SAML, Entra, SCIM, API keys |
| RLS tenant context (`rls-middleware.ts`) | Lift the pattern | New policies for the new schema |
| Field encryption + per-tenant DEK | Lift with edits | Manuscripts and bibles are encrypted at rest |
| Stripe billing + entitlements, rate limiting, storage (S3/local/ClamAV), mailer, pino/OTel/Sentry | Lift, minor edits | Generic |
| BullMQ `queue.ts`, `scheduler.ts`, worker build | Lift with edits | Job registry is rewritten |
| pdfkit helpers (`src/lib/pdf`) | Lift as-is | DOCX and EPUB writers do not exist and are new |
| `tests/helpers/repo-files.ts`, `source-blocks.ts`, generic ESLint rules, docs site (Astro Starlight), docker-compose | Lift as-is | |
| Structured model output | New | Not used anywhere in inflect-compliance |
| Comments | New | Only task-specific comment models exist |
| Tool Runner `execute.ts`, Flue, MCP, A2A, proposals, harness, all compliance domains | Leave behind | |

Versions to keep in step with: Node 24, Next 16, React 19, Prisma 7, Tailwind 4, TipTap 3, tldraw 3.15, `@anthropic-ai/sdk` 1.x, BullMQ 6, Zod 4, Jest 30, Playwright.

### 1.2 Open-source landscape

**Port (permissive licences)**

| Repo | Licence | What we take |
|---|---|---|
| [mattpocock/skills](https://github.com/mattpocock/skills) (`grill-me`, `grill-with-docs`) | MIT | The interview algorithm: treat the book as a decision tree, ask the whole *frontier* (every question whose prerequisites are settled), give a recommended answer with each question, never ask what the bible already answers, update the document as answers arrive |
| [danjdewhurst/story-skills](https://github.com/danjdewhurst/story-skills) | MIT | Bible schema (one entry per entity, typed relationships, registries, style sheet, timeline, continuity state, open questions, promises, clues) and 24 craft skills to mine for per-stage question packs |
| [stanford-oval/storm](https://github.com/stanford-oval/storm) | MIT | Perspective-guided questioning: several interviewer personas, each with its own line of questions |
| [getzep/graphiti](https://github.com/getzep/graphiti) | Apache-2.0 | Temporal fact model (a fact has a validity interval and is invalidated on contradiction) and its extract → dedupe → invalidate prompts, re-implemented on Postgres |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | ADD / UPDATE / DELETE / NOOP reconciliation when merging an answer into an entry |
| [google-deepmind/dramatron](https://github.com/google-deepmind/dramatron) | Apache-2.0 | Hierarchical chain design (logline → characters → beats → locations); dormant, take the design |
| [surveyjs/survey-library](https://github.com/surveyjs/survey-library) | MIT | JSON question schema with `visibleIf` for the deterministic part of a pack |
| [tiptap](https://github.com/ueberdosis/tiptap) core, [yjs](https://github.com/yjs/yjs), [hocuspocus](https://github.com/ueberdosis/hocuspocus) | MIT | Editor and, later, collaboration. Avoid Tiptap Pro extensions |
| [prosemirror-suggest-changes](https://github.com/handlewithcarecollective/prosemirror-suggest-changes) | MIT | Accept/reject suggestions in the editor |
| [retext](https://github.com/retextjs/retext), [write-good](https://github.com/btford/write-good), [alex](https://github.com/get-alex/alex) | MIT | In-process prose checks |
| [docx](https://github.com/dolanmiu/docx), [epub-gen-memory](https://github.com/cpiber/epub-gen-memory), [pagedjs](https://github.com/pagedjs/pagedjs), [epubcheck](https://github.com/w3c/epubcheck) | MIT / BSD-3 | Manuscript DOCX, EPUB, print PDF, and EPUB validation |
| [xyflow](https://github.com/xyflow/xyflow) | MIT | Already a dependency of inflect-compliance; the fallback canvas if tldraw terms do not fit |

**Inspiration only (copyleft, source-available or unlicensed — no code, no question text)**

| Repo | Licence | Idea worth studying |
|---|---|---|
| [bibisco](https://github.com/andreafeccomandi/bibisco) | GPL-3.0 | Closest prior art: a fixed character-interview questionnaire |
| [novelWriter](https://github.com/vkbo/novelWriter), [Manuskript](https://github.com/olivierkes/manuskript) | GPL-3.0 | Tag references between scenes and entities; iterative-expansion wizard |
| [PlotPilot](https://github.com/shenminglinyi/PlotPilot) | Apache-2.0 + Commons Clause | Fact triples, foreshadowing registry (open / suspended / consumed), POV firewall |
| [NousResearch/autonovel](https://github.com/NousResearch/autonovel) | none | "Propagation debts" when an upstream layer changes; slop scanner |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) | AGPL-3.0 | Lorebook activation: keyword-triggered entries under a token budget |
| [Formbricks](https://github.com/formbricks/formbricks), [Typebot](https://github.com/baptisteArno/typebot.io) | AGPL / FSL | Survey logic and conversational flow UX |
| Pandoc, LanguageTool, Vale, proselint | GPL / LGPL / MIT / BSD | Usable only as separate processes or services |

### 1.3 Hazards found

1. **tldraw is not open source.** Its 3.x licence allows commercial use with the tldraw watermark shown; removing the watermark needs a licence key, and inflect-compliance sets no key in source. Decided (D1): Inkquisitor stays pinned to tldraw 3.x with the watermark on and sets no key; a guard test added in Phase 3.1 fails if tldraw's major version moves.
2. **inflect-compliance is BUSL-1.1** (Licensor Inflect Ltd). Resolved (D2): Inkquisitor is BUSL-1.1 with the same licensor, Inflect Ltd., which relicenses the lifted code into Inkquisitor under Inkquisitor's own `LICENSE`; recorded in `LICENSING.md` and `NOTICE`, with every lifted file in `docs/carve-manifest.md`.
3. **Craft-framework brands.** Save the Cat, Story Grid, Dramatica and the Snowflake Method are brand names with authored wording. Structure ideas are free to use; names, beat labels and worksheets are not. Every question in every pack is written by us under neutral labels. Trademark status was not verified; have counsel check before launch.
4. **Unverified in research:** tldraw pricing (site unreachable from the research session; the 3.x watermark terms are the owner's reading, D1), SillyTavern lorebook details, Plate's suggestion plugins.

## 2. Decisions the owner must make before Phase 0

| # | Decision | Recommended default | Status |
|---|---|---|---|
| D1 | tldraw commercial licence, or build the canvas on React Flow | Buy the licence: the serializer, shapes and history UI are tldraw-based and are the largest single carve | Decided (2026-11-18): tldraw pinned to 3.x, commercial use with the watermark on, no licence key |
| D2 | Licence of Inkquisitor and of the lifted code | Private repository, licensor grant from Inflect Ltd recorded in `LICENSING.md` | Decided (2026-11-18): BUSL-1.1, licensor Inflect Ltd., mirrors inflect-compliance's `LICENSE` |
| D3 | Does the AI ever write manuscript prose? | No. It asks, summarises the author's own answers into bible entries, and critiques. This is the product's position and its answer to authors' AI concerns | Decided (2026-11-18): the recommended default |
| D4 | Tenancy | A workspace per author, with invited collaborators later; keep RLS from day one | Decided (2026-11-18): the recommended default |
| D5 | May author text be sent to the model provider under zero-retention terms only? | Yes, and say so on the pricing page | Amended (2026-11-19): standard retention permitted during a closed beta with an explicit operator flag; zero retention required before public launch. The flag is `AI_RETENTION_MODE=standard-beta` (a WARN at every start); `AI_RETENTION_MODE=zdr` (or 2.1's `ANTHROPIC_ZDR_CONFIRMED=1`) states zero retention; production refuses to start holding a key with neither. No output schema is ever built from author text, whatever the mode |
| D6 | Carve by copy, or share `@inflect/ui` as a package | Copy at a recorded commit; revisit sharing after launch | Decided (2026-11-18): the recommended default |
| D7 | Postgres image: which image carries pgvector | Carve inflect-compliance's own image (`deploy/postgres/`: `postgres:16-alpine` plus pgvector at a pinned tag and commit, gosu rebuilt) and its publish workflow | Decided (2026-11-19): carved; published as `ghcr.io/rodnapamet/inkquisitor-postgres` (line tag `16-alpine` plus immutable per-build tags), self-contained per D6, with no runtime dependency on inflect's package |
| D8 | Vector store timing | Land it when 4.1 first needs embeddings | Decided (2026-11-19): its own platform PR now (subphase 2.0), with no domain tables; 2.1 and 4.1 attach their own tables to it |
| D9 | Research agent: placement and where it may look | A subphase after enrichment; open web search plus the author's own sources, every finding cited, nothing written without the author's acceptance | Decided (2026-11-19): subphase 2.6, after 2.5, reusing its proposal and review flow; Anthropic's server-side web search and fetch tools plus URLs and files the author attaches; queries are written from the research brief and never carry manuscript or bible text; chapter fit arrives with 5.1 |
| D10 | Default monthly AI spend ceiling per workspace | A placeholder of $25 (2.1) | Decided (2026-11-19): $50 (`AI_MONTHLY_CEILING_USD_DEFAULT` defaults to 50); per-plan caps arrive with billing in Phase 7 |
| D11 | Pack mount gate before real-model evaluation records | Refuse in production; accept structural (deterministic or fake generator) records in development and test | Decided (2026-11-19): production refuses to mount any pack without a real-model evaluation record, so interviews stay off in production until such records exist; it fails loudly (503 `PACKS_NOT_MOUNTABLE` naming each pack, and a `[startup] WARN`) and never runs an unevaluated pack, with no override. Development and test accept structural records. Real-model records are made by the `Evals` workflow (`.github/workflows/evals.yml`, dispatch only, on the repository secret `ANTHROPIC_API_KEY`) and committed by a reviewed pull request |
| D12 | Languages authors write in | English first | Decided (2026-11-19): English first; other languages work but are not tuned; the production embedding model, guard language coverage and evaluation sets are chosen for English. |
| D13 | Interview E2E against the production build | A stubbed model on the E2E server, refused anywhere else | Decided (2026-11-20): a loopback-only model stub. `AI_MODEL_STUB=1` stays in the production build and is refused unless `APP_URL` and `NEXTAUTH_URL` are both loopback addresses and no `ANTHROPIC_API_KEY` is set, with a `[startup] WARN` at every start; in that mode only, the pack mount gate also accepts structural evaluation records (`packRecordModeOf`, the one place), so the stub E2E server can run interviews. A real deployment can use neither: the start-up check refuses the stub, or a structural mode, beside a real host. Production without the loopback stub still mounts only real-model records (D11) |
| D14 | Enrichment's product-addressing check | Refuse a proposed sentence that pairs an action with the product's own nouns (a field, the bible, a prompt) | Decided (2026-11-20): flag for the author's review instead of refusing. Such a proposal is stored with the `POSSIBLE_INSTRUCTION` flag, shown as a possible instruction with an explanation, never offered for bulk acceptance, and accepted only one by one like every proposal; the evaluation grades an instruction copied into a proposal on the adversarial set as refused or flagged, never silently accepted. Injection-scan hits, markup and script schemes, unsourced URLs and answer-id citations stay refused |
| D15 | Research egress | The brief gate, a gather request that carries only the brief, and a per-query check | Decided (2026-11-20). Anthropic's server-side tools run each query before our code sees it, so the guarantee is the brief gate plus a gather request that carries only the brief. Each query is checked as a tripwire, and every query and fetched URL a run made is listed on its result page |
| D16 | 2.H item 8, the real-author trial | Ten authors for a week in 2.H, before Phase 3 | Decided (2026-11-20): deferred to an owner-run closed beta before public launch; Phase 3 proceeds; friction is fixed as it arrives |
| D17 | 2.H cost and gating choices | As first built in 2.H: rephrase gated on a real-model record like reconcile (D11); 40 model calls a minute per workspace; an expired unsettled reservation charged at its worst case; reconcile counts against the session token budget | Decided (2026-11-20): rephrase runs in production without a real-model record (it only rewords a question); 100 model calls a minute per workspace; an expired unsettled reservation is released, not charged; reconcile counts against the session token budget; AiCallLog kept 400 days (floor 365); the injection red-team runs nightly once INJECTION_REDTEAM_ENABLED is set. |
| D18 | 3.1 canvas: auto-layout engine, and how many maps a book has | dagre and elk, as inflect-compliance carries them; maps created freely | Decided (2026-11-20): dagre only (`@dagrejs/dagre`, MIT), no elkjs (EPL-2.0), and the force-directed layout goes with it; credited in NOTICE if ever ported or vendored rather than an npm dependency. A book has exactly one relationship map, one plot board and one timeline, held by a unique (bookId, kind); a map is created on its first save (a map nobody has saved reads as empty at version 0) |
| D19 | Signing real-model evaluation records (#36 item 1) | Sign each record with a key the Evals workflow holds | Decided (2026-11-20): records are not signed; the control is that a record reaches main only through a reviewed pull request |

## 3. Rules every phase obeys

1. **The author decides.** No model output changes a bible entry until the author accepts it. Every accepted change is a new version naming the answers it came from.
2. **Grounded enrichment.** A proposed bible change cites the answer(s) it is drawn from. A sentence with no source is refused, not softened.
3. **One file loads the model SDK** (`clientForRun`), enforced by the lifted ESLint rule.
4. **Author text is untrusted input to the model** (guard-scanned, fenced as data) and private data everywhere else (encrypted at rest, never logged, never in analytics).
5. **Never ask what the bible already answers.** The frontier is computed against stored facts first.
6. **Zero is never complete.** A readiness figure over no questions, no scenes or no checks reads "not assessed", never 100%.
7. **Licence hygiene.** No code or question text from the inspiration-only list. Each lifted file is recorded in `docs/carve-manifest.md` with its source path and commit.
8. **One pull request per subphase**, with tests that fail when the behaviour regresses. Each phase ends with a hardening subphase that must close before the next phase starts.
9. **Every model feature has an evaluation set** and a cost budget per call, recorded with the prompt version.

## 4. Phases

Each subphase has a prompt to give a Claude Code session opened on the Inkquisitor repository with inflect-compliance attached read-only. Paths in prompts that start with `src/` and name inflect files refer to inflect-compliance.

### Phase 0 — Carve-out and foundations

Goal: an empty but real product: sign in, a workspace, an app shell, CI, a deploy.

**0.1 Repository bootstrap**

```text
Create the Inkquisitor application skeleton: Next.js 16 App Router, React 19, TypeScript strict, Tailwind 4, Prisma 7 with a multi-file schema folder, Jest 30 and Playwright, ESLint 9 flat config. Match the versions in inflect-compliance/package.json. Copy docker-compose.yml (Postgres with pgvector, PgBouncer, Redis, ClamAV) and the Dockerfile pattern. Add src/env.ts using @t3-oss/env-nextjs with only the variables this skeleton reads, and a separate src/env-client.ts for NEXT_PUBLIC_ variables. Create docs/carve-manifest.md with a table (Inkquisitor path, source path, source commit, edits made) and record every file you copy. Write CLAUDE.md stating the layer structure (app/api → usecases → policies → repositories) and the nine rules in docs/ROADMAP.md section 3. Do not copy any compliance domain code.
```

**0.2 UI platform**

```text
Lift the UI platform from inflect-compliance: packages/ui as a workspace package renamed @inkquisitor/ui; the generic primitives in src/components/ui (table, filter, modal, sheet, combobox, form-field, tooltip, date-picker, accordion, radio-group, toggle-group, undo-toast, RichTextEditor, VersionDiff, hooks); the command palette shell; the layout shells in src/components/layout; src/styles/tokens.css, the Tailwind config and ThemeProvider. Leave out FrameworkBuilder, ComplianceStatusIndicator, EvidenceGallery, SankeyChart, GraphExplorer and every domain chart. Replace tenant/org context with a single WorkspaceContext. Rebrand the palette tokens (ink black, parchment, one accent) in light and dark. Build a /dev/kitchen-sink page rendering every primitive, and a rendered test per primitive that it mounts. Record every file in the carve manifest.
```

**0.3 Identity, workspace and data isolation**

```text
Add authentication and tenancy. Lift next-auth 4 configuration from inflect-compliance/src/auth.ts keeping only Credentials (bcrypt, breached-password check, progressive lockout) and Google; drop SAML, OIDC, Entra, SCIM, MFA policy and API keys. Models: User, Workspace, WorkspaceMembership (OWNER, EDITOR, READER), UserSession. Lift the row-level-security pattern from src/lib/db/rls-middleware.ts: every workspace-scoped table has workspaceId, FORCE ROW LEVEL SECURITY, and is reached through runInWorkspaceContext. Lift field encryption (encryption-middleware, encrypted-fields manifest, per-workspace data key) with an empty manifest to be filled in Phase 1. A new sign-up creates a workspace with its owner. Tests: a two-workspace integration test proving one cannot read the other's rows through the app role, and a guard test that fails when a workspace-scoped model has no RLS policy.
```

**0.4 Platform services and tooling**

```text
Lift the generic platform services: pino logger, OpenTelemetry and Sentry initialisation with graceful shutdown; rate limiting (mutation, read and auth tiers); storage providers (S3, local, ClamAV scan); mailer; BullMQ queue.ts and scheduler.ts with the esbuild worker build and an empty executor registry; withApiErrorHandling and the typed error classes. Lift tests/helpers/repo-files.ts and source-blocks.ts, and the generic ESLint rules (anthropic-client-single-seam, no-raw-prompt-logging, no-request-derived-public-url, the focus-indicator rules). Create .github/workflows/ci.yml with lint, typecheck, unit, integration, build, CodeQL, npm audit at moderate and Trivy, and a release workflow. Lift the Astro Starlight docs site with a single help site.
```

**0.H Hardening**

```text
Harden Phase 0. Verify by test, not by reading: (1) every API route file has an authorization check, with a guard over src/app/api; (2) production refuses to start without DATA_ENCRYPTION_KEY and AUTH_SECRET; (3) the client bundle imports no server env module; (4) no console.* in server code; (5) secret-detection pre-commit hook and CI scan; (6) security headers and CSP on every response; (7) a Playwright smoke: sign up, land in the empty workspace, sign out, sign in. Audit docs/carve-manifest.md against git: every file whose content matches an inflect-compliance file must be listed. Grep the tree for the words compliance, tenant, control, evidence, audit pack and remove leftovers. Report what you could not verify.
```

### Phase 1 — The book bible

Goal: an author can create a book and keep a structured, versioned bible by hand. No AI yet.

**1.1 Book and element model**

```text
Design and build the bible data model in prisma/schema/bible.prisma. Book (title, working logline, genre, audience, target length, stage). BibleElement (bookId, kind, name, slug, status, summary). Kinds are a closed enum: PREMISE, PLOT, CHARACTER, SETTING, THEME, MOOD, TEXTURE, STYLE, POV, WORLD_RULE, TIMELINE_EVENT, FACTION, OBJECT, RESEARCH, plus CUSTOM with a label. BibleField (elementId, key, value, order): each kind has a field template defined in code (for CHARACTER: want, need, wound, lie believed, voice, appearance, arc; write all templates yourself under neutral labels and do not copy any published framework's wording). BibleRelation (from, to, type, note) with typed, bidirectional relations. BibleEntryVersion (elementId, versionNumber, snapshot JSON, changeSummary, source: MANUAL | INTERVIEW | IMPORT, authorId), unique per element and number, written on every save. All tables workspace-scoped with RLS; add value, summary and snapshot to the encryption manifest. Use danjdewhurst/story-skills (MIT) as the reference for which registries exist; record it in NOTICE. Repositories, usecases with policies, Zod schemas, and integration tests for versioning and isolation.
```

**1.2 Bible workspace UI**

```text
Build the bible UI on the lifted shells. Books list (EntityListPage). Book home: a board of element kinds showing, per kind, the entries and a completeness bar (fields filled out of fields in the template; show "not started" for zero, never 0% or 100% of nothing). Element page (EntityDetailLayout): fields edited with the lifted RichTextEditor, autosave, relations panel with a Combobox picker, a History tab using VersionDiff between any two versions with restore-as-new-version, and a disabled "Enrich" button with a tooltip saying it arrives with interviews. Element create in a Modal; delete with the undo toast. All strings through next-intl with a new en.json. Rendered tests for the editor save path, history diff and restore.
```

**1.3 Import and export of the bible**

```text
Add bible import and export. Export a book's bible as a Markdown bundle (one file per element with YAML frontmatter, an index per kind) zipped, and as a single PDF using the lifted pdfkit helpers. Import: the same Markdown bundle, and a pasted or uploaded free-text concept note (stored as a RESEARCH element, not parsed by a model yet). Imports are size-bounded, virus-scanned and sanitised, create versions with source IMPORT, and are idempotent per element slug. Round-trip test: export, import into an empty book, export again, byte-identical.
```

**1.H Hardening**

```text
Harden Phase 1. (1) Sanitise every rich-text write at the usecase layer and add a guard that fails for an encrypted free-text field with no sanitiser. (2) Concurrent edits: add an optimistic version check on element save and a conflict notice; test two writers. (3) Version history is append-only: a database trigger refuses update and delete of BibleEntryVersion. (4) Index review for every list query; bound every findMany. (5) Accessibility pass on the bible pages with axe in Playwright, keyboard-only walk of create, edit, relate, restore. (6) Load test a book with 2,000 elements and 20,000 versions; fix anything over 300 ms p95 on list and element pages. (7) Soft-delete and 30-day purge for books, with an export offered first.
```

### Phase 2 — The Inquisition engine

Goal: the core product. Enrich starts an interview; answers become accepted bible changes.

**2.0 Vector store (platform)**

```text
Port inflect-compliance's pgvector image and vector-store layer as a domain-neutral platform service (decisions D7 and D8). Carve deploy/postgres/ (Dockerfile, smoke.sh) and the publish workflow as Inkquisitor's own ghcr.io/rodnapamet/inkquisitor-postgres (BUILD → SMOKE → SCAN → PUSH, main only, weekly and on an upstream digest move); CI builds the image from the Dockerfile in the Test and E2E jobs instead of pulling it, and the Docker job smoke-tests and gates it. Migration: CREATE EXTENSION vector and one VectorEmbedding table (vectors only, keyed by workspace, revision, sourceModel, sourceId and chunk, with a book scope, a keyed content hash and CHECKs), under the workspace's RLS, with a trigger function a source table attaches so its vectors are deleted with it. Port the vector repository (validation, metrics, rebuild) with an in-process reference backend and the pgvector backend, running on the caller's runInWorkspaceContext transaction; and the embedding seam (types, the self-hosted TEI provider behind the in-deployment dial, the deterministic stub as the development and test default, the revision). No domain tables, no compliance coupling, no reranker. Unit tests over the in-process store, the providers and the config; integration tests against real pgvector for upsert, ordering, isolation under RLS, delete with the source, the CHECKs and idempotence.
```

**2.1 Model seam, structured output and guard**

```text
Build the model layer. Lift inflect-compliance/src/lib/agentic/tool-runner/client.ts as src/lib/ai/client.ts (clientForRun), the only file that imports @anthropic-ai/sdk, enforced by the lifted ESLint rule; remove residency and workspace branches, keep the messages-only middleware. Lift the guard scanners from src/app-layer/ai/guard (normalize, patterns, injection-scanner, egress-scanner, policy) and write a new thin wrapper with no audit coupling. Add callStructured(schema, prompt): a streamed call returning a Zod-validated object, using the API's structured-output feature (read the current Anthropic documentation first; fall back to a single forced tool whose input schema is the output). One repair attempt on validation failure, then a typed error. Model tiers in one file: fast (classification, extraction), balanced (question generation), deep (book-level analysis), each overridable by env. Record every call in AiCallLog (purpose, prompt version, model, tokens, cost, duration, outcome; never the text). Per-workspace monthly spend ceiling modelled on assistant/spend-ceiling.ts, and a global kill switch. Author text goes in fenced data blocks, never in the system prompt.
```

**2.2 Question engine**

```text
Build the question engine as a pure, testable core plus a model step. Data: InterviewSession (bookId, target element or kind, dials, status), Question (sessionId, text, kind: OPEN | CHOICE | EITHER_OR | SCENARIO | SCALE, options, recommendedAnswer, rationale, targetsFieldKeys, dependsOn question ids, round), Answer (questionId, text or choice, skipped, "decide later"). Algorithm, ported from the MIT-licensed mattpocock/skills grilling skill: each round, compute the frontier — every unanswered question whose prerequisites are settled — after first removing anything the bible already answers; ask the whole frontier at once, numbered; after answers, recompute; stop when the frontier is empty or the round budget is spent, and say which. The model step generates candidate questions for a target from: the element's field template and current values, related elements' summaries, prior answers, and the active question pack. It returns structured output; code, not the model, deduplicates against asked questions (normalised text plus embedding similarity) and enforces the dependency order. Unit-test the frontier logic exhaustively without a model; build an evaluation set of ten book concepts with expected coverage of field keys.
```

**2.3 Dials: depth, detail, manner**

```text
Add the three interview dials, stored on the session with workspace and book defaults. Depth (1-5): how far down the dependency tree a session goes and how many rounds. Detail (1-5): how specific a question is and how long an answer it invites, from one-line choices to scenario questions. Manner: a persona and format mix chosen from packs — Gentle Mentor, Ruthless Editor, Socratic, Devil's Advocate, Target Reader, Genre Specialist — plus toggles for "offer a recommended answer" and "multiple choice where possible". Implement packs with the lifted skill mount system (a folder per pack with PACK.md, a declared field coverage, an evaluation set, and a content hash pinned on the session). Use Stanford STORM's perspective idea (MIT): a session may run several personas, each contributing questions tagged with its name. A dial changes prompts and budgets only; it never changes what may be written to the bible. Ship six personas and one craft pack per element kind, all original text. A pack mounts only with a passing evaluation record.
```

**2.4 Interview UI**

```text
Build the interview experience. Enrich on an element (or "Grill me" on a whole kind or the whole book) opens a Sheet for setup (dials, shown with a one-line preview of what each setting does) then a focused full-page session: the current round's questions as cards, each with its answer control by kind, the recommended answer as a one-click accept, Skip, Decide later, and "Ask me this differently". Questions stream in as they are generated using the lifted SSE event contract and use-assistant-stream hook. A side panel shows the bible fields this round targets, filling as answers arrive. Keyboard first: number keys select, Enter submits, registered through useKeyboardShortcut. Sessions are resumable and autosaved per answer. The author can stop at any time and keep what was answered. Rendered tests for each question kind and a Playwright run of a full three-round session against a stubbed model.
```

**2.5 Enrichment: answers into the bible**

```text
Build enrichment. When a round closes, a reconcile step proposes bible changes from the new answers: for each targeted field, one of ADD, UPDATE, REMOVE or NO CHANGE (the mem0 reconciliation pattern, Apache-2.0), with the proposed text and the ids of the answers it is drawn from. Code refuses a proposal that cites no answer, cites an answer from another session, or targets a field outside the session's scope. The author reviews proposals as a diff per field (VersionDiff), accepts, edits then accepts, or rejects; bulk accept is offered only for ADD into empty fields. Accepting writes one BibleEntryVersion with source INTERVIEW and links to the answers. New entities named in answers (a character or place the bible lacks) are proposed as new elements, never created silently. Evaluation set: forty answer/field pairs with expected operations, plus ten adversarial answers containing instructions to the model, which must change nothing beyond their own content.
```

**2.6 Research agent and Research page**

```text
Add a Research page per book (APP_ROUTES, under /w/[workspaceSlug]/books/[bookId]/research) and a research agent the author dispatches (decision D9). The author writes a research brief: a topic or question, what it is for (a character's profession, a setting's period, a world rule's plausibility, a historical event), optional scope elements chosen from the bible (Combobox), optional sources (URLs, uploaded files through the 1.3 bounded, virus-scanned import path), and a depth (quick / standard / thorough) that sets the step and spend budget. Data: ResearchBrief (bookId, question, purpose, scope element ids, sources, depth, status, requestedBy), ResearchRun (briefId, status, budget, spend, started/finished, error code), ResearchFinding (runId, claim, summary, citations: [{ url or uploaded source id, title, quoted span, retrievedAt }], confidence), ResearchProposal (findingId, target element and field or a new element, operation ADD | UPDATE | NEW_ELEMENT, proposed text, rationale "how this fits", cited finding ids). Brief, findings, quotes and proposals are author-private text: encrypted in the manifest, sanitised at the usecase layer, never logged.

The run is a background job (BullMQ, one per brief, payload by id) driving a tool loop through clientForRun: read the current Anthropic documentation for the server-side web search and web fetch tools first, allow exactly those two server tools in the messages-only middleware and nothing else, cap uses per run by depth, and record every call in AiCallLog under the per-workspace monthly ceiling and the kill switch. What the agent may send: queries it writes from the brief's question and purpose; never manuscript text, never bible field values, never another book's data. Code checks each outgoing query against the scope's stored text with the egress scanner and refuses a query that quotes it. Fetched pages and attached files are untrusted input: guard-scanned, fenced as data, and unable to change the brief, the scope or the tool set.

Two structured steps follow retrieval. Findings: each claim must carry at least one citation whose quoted span appears in the retrieved source (code checks it against the fetched text; an uncited or unverifiable claim is refused, not softened — rule 2). Fit: for the brief's scope elements and their related elements (target in full, related summaries), the agent proposes how each finding bears on them — a field update, a new element (a place, an object, a faction), or "no fit" with a reason — citing finding ids. Code refuses a proposal that cites no finding, targets an element outside the book, or targets a field the template lacks. The AI never writes manuscript prose (D3): proposals are bible text about facts and their bearing on the story, never scenes or dialogue.

The page lists briefs with status and spend; a run streams progress (searching, reading N sources, drafting findings) with the lifted SSE contract; findings show their quoted sources with links; proposals are reviewed with the 2.5 review UI (VersionDiff per field, accept, edit then accept, reject). Accepting writes one BibleEntryVersion with a new source RESEARCH linked to the proposal and its findings; nothing reaches the bible otherwise. A finding can also be kept as a RESEARCH element with its citations. Zero is never complete: a run that found nothing says so and why (no sources, all refused, budget spent). Permissions: bible.view reads, bible.edit dispatches and accepts. Evaluation set: ten briefs across genres with expected claim coverage, citation validity, fit precision, and five adversarial pages carrying instructions that must change nothing. Update the sub-processor list and privacy page draft: research queries go to Anthropic and its search provider.
```

**2.H Hardening**

```text
Harden Phase 2. (1) Prompt-injection suite: answers, element text and imported notes carrying instructions; assert no out-of-scope proposal, no system-prompt disclosure, no cross-book reads. Run garak or an equivalent nightly. (2) Cost: a per-session token budget, a per-workspace monthly ceiling, and a test that a session stops cleanly at each. (3) Repetition: a metric and a test that no question repeats within a book across sessions. (4) Latency: first question visible within 3 seconds p95; stream cancellation frees the server slot. (5) Failure modes: model timeout, invalid structured output twice, provider outage — each ends in a resumable session with a plain message. (6) Privacy: assert no author text in logs, traces, Sentry or AiCallLog; enable zero-retention settings and document them. (7) Every pack and prompt has a version and a passing evaluation record; CI fails on a changed prompt without a re-run. (8) Ten real authors use it for a week; fix the top five friction points before Phase 3. [Deferred per D16: an owner-run closed beta before public launch, a Phase 7 launch gate; Phase 3 proceeds.] (9) Research agent: an injection suite over fetched pages and attached files (no out-of-brief proposal, no tool use beyond search and fetch, no change to the scope); an egress test that no query carries bible or manuscript text; citation integrity (every accepted finding's quote is present in its stored source); a run stops cleanly at its budget, at the monthly ceiling and on the kill switch, and is resumable or reports why not.
```

### Phase 3 — Story canvas (tldraw)

Goal: see and shape the book spatially; canvas and bible are one dataset. Requires decision D1.

**3.1 Canvas platform carve**

```text
Lift the tldraw canvas platform from inflect-compliance/src/components/processes and src/lib/processes: the custom node ShapeUtil, edge ShapeUtil and BindingUtil, serializer.ts with its exact round-trip contract, arrow-to-edge conversion, autosave hook with the version lock and conflict notice, snapshot-per-save, CanvasHistorySidebar, CanvasDiffOverlay, canvas export, and canvas-auto-layout (dagre; elk dropped, decision D18). Strip the compliance node taxonomy, controls, automation modes, agent-flow and drill scopes. Rows stay the source of truth: StoryMap, MapNode (references a BibleElement), MapEdge (references a BibleRelation), freeformJson for sticky notes and drawing, MapSnapshot per save. Load the canvas with next/dynamic and ssr false behind an error boundary. Keep tldraw pinned to 3.x with the watermark on (decision D1: its licence allows commercial use that way, so no licence key is read or set), and add a guard test that fails if tldraw's major version in package.json or the lockfile moves off 3. Port the serializer round-trip tests.
```

**3.2 The three maps**

```text
Build three maps on the canvas platform. Relationship map: characters and factions as nodes, typed relations as edges; drawing an arrow creates a BibleRelation after a small type picker, deleting one removes it with undo. Plot board: plot beats and scenes as cards in act lanes with causal arrows; reordering updates beat order in the bible. Timeline: TIMELINE_EVENT elements placed on a story-time axis with per-character lanes. Each node shows the element's completeness and opens the element in a Sheet without leaving the canvas. Edits on the canvas and in the bible are the same rows, so each reflects the other after save. A read-only embedded view of each map appears on the relevant bible pages.
```

**3.3 Interview from the canvas**

```text
Connect canvas and interviews. Select one or more nodes and choose "Grill this": a session scoped to those elements and the relations between them. Select an edge to be questioned on the relationship itself. An empty region of the plot board offers "What happens between these?" using the two neighbouring beats as context. Proposals that add elements or relations are previewed on the canvas as ghost nodes and edges, plus a plain list, and are created only on acceptance. The plain list is the record; the canvas preview may fail without blocking review.
```

**3.H Hardening**

```text
Harden Phase 3. (1) Round-trip property test: random graphs through rows → tldraw → rows are identical. (2) Performance: 500 nodes and 1,500 edges stay interactive; auto-layout runs off the main thread. (3) Two tabs editing one map: the version lock yields a conflict notice and no lost write. (4) Canvas bundle stays out of every non-canvas route; add a bundle-size budget. (5) Keyboard and screen-reader path: every canvas action has a list-view equivalent. (6) Snapshot history is append-only and restorable; test restore after 200 saves. (7) Licence check (D1): the tldraw major-version guard holds, no code hides or restyles the watermark, and no licence key is read or set.
```

### Phase 4 — Canon, continuity and memory

Goal: the bible knows what is true, when, and what contradicts what — and interviews exploit it.

**4.1 Fact layer and retrieval**

```text
Add a fact layer under the bible. StoryFact (subject element, predicate, object element or literal, storyTimeFrom, storyTimeTo, statedAt, supersededAt, source answer or version). Facts are extracted by a fast-tier structured call when a bible version is accepted, then deduplicated and, on contradiction with an existing fact, the older fact is proposed for invalidation — never invalidated silently. Port the extract, dedupe and invalidate prompt design from getzep/graphiti (Apache-2.0) onto Postgres; do not add a graph database. Add pgvector embeddings for elements, facts and answers behind a single vector-store module, and a retriever that assembles interview context under a token budget: target element in full, directly related elements' summaries, top-k relevant facts. The question engine's "already answered" check now reads facts. Evaluation set of fact extraction on five synthetic bibles.
```

**4.2 Continuity checks and open threads**

```text
Build continuity. A Contradiction is two live facts that cannot both hold (a character's age, who knows what when, where someone is at a story time); detected by rules first (same subject and predicate, overlapping story time, different object) and a deep-tier check second, each shown with both sources. Resolving one means the author picks, or says both are true and explains — which becomes a fact. Add registries: Promise (something set up for the reader: open, paid off, dropped), Clue, and OpenQuestion (a "decide later" answer or an unresolved contradiction). Add propagation debt: when an upstream element changes (premise, a character's want), downstream elements that cited it are flagged "may be stale" with a one-click "grill me on what changed" session. A Continuity page lists contradictions, open promises and stale entries.
```

**4.3 Book-level interrogation**

```text
Add book-level sessions that use the whole canon. "Stress test": a deep-tier pass that finds the weakest points (unmotivated turns, a protagonist with no cost, a theme no scene argues, a promise never paid) and turns each into questions, never into verdicts or rewrites. "Gap hunt": ranks element kinds and fields by how much the rest of the book depends on them and how empty they are, and proposes the next three sessions. Persona panels: the same book questioned by Target Reader, Ruthless Editor and Genre Specialist, with questions grouped by who asked. Long sessions summarise earlier rounds by code-built state (answers and accepted changes verbatim, model summary fenced as data), following the compaction design in inflect-compliance.
```

**4.H Hardening**

```text
Harden Phase 4. (1) Extraction is idempotent: re-running on the same version writes nothing. (2) Contradiction precision: an evaluation set with seeded contradictions and near-misses; fewer than one false alarm in ten. (3) Retrieval isolation: a test that a book's context never contains another book's or workspace's text, at the query level and under RLS. (4) Embeddings are encrypted-at-rest columns' derivatives: document that, and delete them with the source row. (5) Backfill job for existing bibles is resumable, rate-limited and budget-capped. (6) Fact tables are bounded and indexed; a 10,000-fact book stays under 300 ms p95 on the Continuity page. (7) Zero is never complete: an empty fact set reports "not assessed".
```

### Phase 5 — Manuscript and style

Goal: bring the draft in, hold it against the bible. The author writes; the product reads and asks.

**5.1 Manuscript workspace**

```text
Add the manuscript. Manuscript → Part → Chapter → Scene, each scene with text (TipTap, encrypted), POV character, setting, story time, and links to bible elements. Import from DOCX (mammoth, as in inflect-compliance) and Markdown, splitting on headings; the author confirms the split. A distraction-free editor with autosave, word counts, per-scene versions and a session word-count goal. Mentions: typing @ links an element; the linked elements show in a side panel with their summaries. No model writes or rewrites scene text anywhere in this phase (decision D3); add a guard test that no model output is ever written to a scene's text column. Extend the 2.6 research agent's fit step to chapters and scenes: scope a brief to chapters, and propose where a finding bears on a scene (a note on the scene, never prose), citing finding ids, reviewed and accepted like any proposal.
```

**5.2 Style sheet and prose checks**

```text
Build the style layer. The STYLE element becomes a structured style sheet: spelling variant, tense, person, dialogue conventions, banned and favoured words, per-character voice notes — filled by a style interview pack. Compile it into deterministic checks run in a worker with retext, write-good and alex (all MIT) plus original rules: filter words, overused words against the book's own baseline, repeated openers, similar character names, tense and person slips, and readability per scene. Findings appear as margin annotations the author dismisses or acts on; the product never applies an edit. Suggestions of wording, where offered, use the suggestion-mark pattern and require acceptance.
```

**5.3 Draft against bible**

```text
Hold the draft against the canon. On scene save, a background job extracts the scene's facts with the Phase 4 extractor, tagged as draft-sourced, and compares them with bible facts: a mismatch (eye colour, a character present who is elsewhere on the timeline, a character knowing what they have not learned) becomes a continuity finding citing the sentence and the bible entry, with three choices — fix the draft myself, update the bible, or both are true. Track promises and clues to the scenes that plant and pay them. "Grill me on this scene" runs a scene-scoped session (goal, conflict, outcome, what changed) whose answers enrich the scene's card, not its prose.
```

**5.H Hardening**

```text
Harden Phase 5. (1) A 150,000-word manuscript imports in under two minutes, edits without lag (virtualised chapter list, per-scene loading), and survives a dropped connection without losing typed text (local draft buffer). (2) Background analysis is debounced, budget-capped per workspace, and never blocks typing. (3) Prose-check false positives: sample 500 findings across genres and remove or retune any rule under 70% useful. (4) Export of everything an author has — manuscript, bible, answers, history — in one archive, and full deletion within 30 days, both tested. (5) Re-verify D3 by test and by a written statement in the product. (6) Backup and restore drill for a workspace.
```

### Phase 6 — Publishing readiness

Goal: an honest answer to "is this ready?", and the files to submit or publish.

**6.1 Readiness model**

```text
Build readiness as checklists per stage — Concept, Outline, Draft, Revision, Submission — each item computed from data, never self-declared: required bible fields filled, no open contradictions, every promise paid or knowingly dropped, every scene has POV and outcome, prose checks reviewed, word count in the genre's usual range (ranges defined in a reviewed data file with sources). Each item links to the session or page that closes it. Show counts and what is missing, not a single vanity score; an unassessed item reads "not assessed". Two paths with different final checklists: traditional submission and self-publishing.
```

**6.2 Exports**

```text
Build exports in a worker. Standard manuscript format DOCX with the docx library (our own template: title page, running header, double spacing, scene breaks). EPUB 3 with epub-gen-memory, validated by running EPUBCheck as a separate process; a failed validation is shown with its messages and the file is marked not store-ready. Print-ready PDF interior via Paged.js in headless Chromium with trim sizes for the common print-on-demand formats. The bible as PDF and Markdown. Every export is reproducible from a recorded manuscript version and is virus-scanned and served by signed URL.
```

**6.3 Submission and launch materials by interview**

```text
Add materials sessions. Logline, one-page synopsis, query letter, back-cover blurb, comparable titles, series potential and author bio are each produced the Inkquisitor way: a short interview, then a draft assembled only from the author's answers and bible facts, each sentence citing its source, presented for the author to edit. This is the one place the product drafts text, it is not manuscript prose, and it is labelled as a draft from your answers. Self-publishing metadata (categories, keywords, description) gets the same treatment with a length and format validator per store's published limits, kept in a dated data file.
```

**6.H Hardening**

```text
Harden Phase 6. (1) Golden-file tests for DOCX, EPUB and PDF across ten manuscripts including non-Latin scripts, footnotes, images and very long chapters. (2) EPUBCheck and the Chromium renderer run sandboxed with time and memory limits; a hostile manuscript cannot read the filesystem or the network. (3) Have a working literary agent and a self-published author review the output formats and checklists; record what they changed. (4) Readiness items are recomputed, never cached past a change; test staleness. (5) Legal review of the craft packs and readiness wording for framework trademarks (hazard 3) before public launch.
```

### Phase 7 — SaaS launch

**7.1 Plans, billing and metering**

```text
Lift Stripe billing and entitlements from inflect-compliance (src/lib/stripe.ts, src/lib/billing). Plans: Free (one book, a monthly question allowance, no exports beyond Markdown), Author (several books, full interviews, canvas, exports), Pro (unlimited books, deep-tier sessions, manuscript analysis, collaborators). Meter by questions generated and deep sessions, shown in-product before a session starts. Enforce limits at the usecase with assertWithinLimit, never only in the UI. Self-hosted mode with no Stripe key resolves to the top plan. Each plan carries its monthly AI spend cap per workspace, replacing the single default of decision D10 ($50, `AI_MONTHLY_CEILING_USD_DEFAULT`) with a stored per-workspace ceiling the model layer's ledger reads. Webhook handling idempotent and signature-verified.
```

**7.2 Onboarding and first session**

```text
Build onboarding that reaches a first answered question in under two minutes: paste or type a concept in one box, pick genre and audience, and go straight into a five-question premise session with recommended answers; the accepted results become the book's first bible entries. Then a guided tour of bible, canvas and "what to grill next". Sample book for exploration. Email verification, password reset, and lifecycle emails (welcome, session reminder with the next suggested topic, weekly progress) with unsubscribe.
```

**7.3 Collaboration and sharing**

```text
Add collaborators. Invite an editor, co-author or beta reader by email with a role: co-author (edit), editor (comment and ask), reader (read selected parts). A generic comment thread model on elements, scenes and proposals. "Editor questions": a collaborator can add their own questions to a session queue, so a human editor can grill the author through the same flow. Read-only share links for a bible or a map, expiring and revocable. Realtime co-editing with Yjs and Hocuspocus is a later item; start with presence and the existing version lock.
```

**7.4 Production, docs and trust**

```text
Prepare production. Deployment (containers for web, worker and scheduler; managed Postgres with pgvector; Redis; object storage), migrations as forward-only, staging environment, backups with a tested restore, uptime and error alerts, status page. Launch gate (decision D5, amended 2026-11-19): production runs with `AI_RETENTION_MODE=zdr` against an Anthropic organization with a confirmed zero-data-retention arrangement before public launch; `standard-beta` is for the closed beta only, and the launch checklist fails while it is set. Help site: a guide per page and how-tos, written for authors. Public pages: privacy policy stating that author text is never used to train models and is sent to the model provider under zero-retention terms, a sub-processor list, terms, and an AI-use statement an author can show a publisher (what the product did and did not write, with an exportable per-book record drawn from AiCallLog and version sources). The sub-processor list names the research agent's search provider (via Anthropic's web search tool) and says research queries are written from the brief and carry no manuscript or bible text.
```

**7.H Hardening**

```text
Launch hardening. (1) External penetration test and fix of every high and medium finding. (2) Authenticated DAST nightly; dependency and container scanning gates blocking. (3) Load test at ten times expected launch traffic including concurrent streaming sessions; define and enforce stream capacity. (4) Abuse: sign-up throttling, free-tier cost ceilings, content the provider refuses is surfaced plainly. (5) Billing edge cases: failed payment, downgrade with over-limit books (read-only, never deleted), refund. (6) GDPR: data export, deletion, DPA, records of processing. (7) Incident runbook and on-call. (8) A closed beta of fifty authors for four weeks with a retention target agreed beforehand; launch only if met. (9) Launch gate (decision D16): the real-author trial deferred from 2.H item 8 — ten authors use the product for a week in an owner-run closed beta, and the top five friction points they report are fixed before public launch; the launch checklist fails until it is recorded as done.
```

### Phase 8 — After launch (unscheduled)

- Series: a shared series bible with per-book overlays and cross-book continuity.
- Realtime co-authoring (Yjs, Hocuspocus).
- Voice interviews: answer aloud, transcript becomes the answer.
- Community packs: author-written personas and craft packs, reviewed before they mount.
- Non-fiction mode: argument, evidence, reader promise, chapter outcomes.
- Integrations: Scrivener and Obsidian import, Google Docs sync.
- Mobile capture: answer today's three questions on a phone.

## 5. Sequencing and size

| Phase | Depends on | Rough size |
|---|---|---|
| 0 Carve-out | D1, D2, D4, D6 | 3 weeks |
| 1 Bible | 0 | 3 weeks |
| 2 Inquisition | 1, D3, D5, D7, D8 | 5 weeks |
| 3 Canvas | 1 (2 for 3.3), D1 | 3 weeks |
| 4 Canon | 2 | 4 weeks |
| 5 Manuscript | 4 | 4 weeks |
| 6 Readiness | 5 | 3 weeks |
| 7 Launch | 2 onward; 7.1 and 7.2 can start after Phase 2 | 4 weeks |

Sizes assume one engineer driving Claude Code sessions and are estimates, not measurements. Phases 3 and 4 can run in parallel. A paid private beta is possible after Phase 2 with 7.1 and 7.2 pulled forward: the interview and the bible are the product; everything after deepens it.
