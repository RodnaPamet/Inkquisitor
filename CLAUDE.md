# CLAUDE.md

Guidance for Claude Code (and anyone else) working in this repository.

Inkquisitor takes an author from a book concept to publishing readiness by
reverse prompting: the product asks, the author answers, and the answers become
the book bible. **`docs/ROADMAP.md` is the source of truth for intent**: the
owner's decisions are its section 2, the rules every change obeys its section 3,
and the work is its phases, one pull request per subphase.

Inkquisitor is carved out of inflect-compliance (same owner, same licensor,
BUSL-1.1). Code is copied at a recorded commit, never shared as a package
(decision D6), and every copied or adapted file is listed in
`docs/carve-manifest.md`. Do not copy compliance domain code.

## Commands

```bash
npm run dev               # Next.js dev server on :3000
npm run build             # next build --webpack
npm run build:check       # the build, failing on any warning, a Node-only proxy bundle or server env in a client chunk (CI's Build)
npm start                 # next start (after build)
npm run worker            # BullMQ worker from source (tsx; loads .env then .env.local, as next dev does)
npm run build:worker      # esbuild → dist/worker.mjs, dist/worker-healthcheck.mjs
npm run secret-scan       # scripts/detect-secrets.sh (staged files; --all for every tracked file)
npm run packs:evaluate    # re-run the interview packs' evaluation sets, structural records beside the packs (2.3)
npm run packs:evaluate -- --no-packs --reconcile   # the reconcile step's sets (2.5): its structural record beside them
npm run packs:evaluate -- --no-packs --research    # the research agent's sets (2.6): its structural record beside them
npm run redteam:injection -- --out redteam-out   # the injection corpus against the REAL model (the nightly workflow runs it; needs a key and a budget)
npm run packs:evaluate -- --no-packs --rephrase    # "Ask me this differently"'s set (2.H): its structural record beside it
npm run packs:evaluate -- --no-packs --sources     # source fact extraction's set (4.0): its structural record beside it
npm run packs:evaluate -- --no-packs --bible-facts # bible fact extraction's set (4.1): five synthetic bibles, its structural record beside it
npm run packs:evaluate -- --no-packs --continuity  # the nightly deep continuity check's set (4.2): its structural record beside it
npm run packs:evaluate -- --no-packs --book-level  # the stress test's, the gap ranking's and the rounds summary's sets (4.3): their structural records
npm run packs:evaluate -- --no-packs --question-order  # the interview tie-break's set (4.4): its structural record beside it
npm run packs:evaluate -- --judge                  # also the judge's report over the pack records written (2.H; a report, never a gate)
npm run docs:build        # the Starlight help site (site/), from docs/user/
npm run lint              # eslint . (flat config, eslint.config.mjs)
npm run typecheck         # tsc --noEmit, then packages/ui alone (no `@/` imports there)
npm test                  # Jest, unit (tests/unit, tests/guards, eslint-rules/__tests__) + rendered projects — no DB, no network
npm run test:integration  # Jest, integration project (tests/integration) — real PostgreSQL and Redis
npm run test:load         # the bible load test at full size (2,000 elements, 20,000 versions; CI runs 400 / 4,000)
npm run test:e2e          # Playwright against `next start` on :3100 (E2E_PORT moves it; build first)
npm run db:generate       # prisma generate (also the postinstall step)
npm run db:migrate        # prisma migrate dev
docker compose up -d      # Postgres + pgvector, PgBouncer, Redis, ClamAV
node scripts/carve-audit.mjs <inflect checkout>   # files matching inflect-compliance but missing from the carve manifest (by hand, each hardening subphase)
```

Every one of `lint`, `typecheck`, `test`, `test:integration` and `build` must
pass before a change is finished. CI (`.github/workflows/ci.yml`) runs them as
the checks **Lint**, **Typecheck**, **Test** (unit, migrations, integration
against Postgres with pgvector, built in the job from `deploy/postgres/Dockerfile`,
and Redis) and **Build** (app through `npm run build:check`,
and the worker bundle), plus
**Security** (`npm audit --omit=dev --audit-level=moderate` and the secret
scan), **CodeQL** (javascript-typescript; the SARIF is kept as an artifact and
`scripts/sarif-gate.js` fails the check on a high-severity security result)
**Docker** (the app image and the Postgres image: build, Trivy
CRITICAL,HIGH, ignore-unfixed; the Postgres image is smoke-tested too) and **E2E** (Playwright against the production
build, with the same built Postgres and Redis; the report is kept as an artifact on failure). The job names are the check names, so never
rename one, and never lower a gate to get a change through
(`tests/unit/ci-workflow.test.ts`). `release.yml` tags and publishes a GitHub
Release from conventional commits with GITHUB_TOKEN alone; `docs-site.yml`
builds the help site and deploys it only on main when Pages is enabled;
`postgres-image.yml` publishes `ghcr.io/rodnapamet/inkquisitor-postgres`
(main only, weekly and on an upstream digest move; build, smoke, Trivy, then
push); `evals.yml` (**Evals**, dispatch only, not a check) makes real-model
pack evaluation records (and, with its `reconcile`, `research`, `rephrase`, `sources`, `bible_facts`, `continuity` and `book_level` inputs, the reconcile step's, the research agent's, the rephrase prompt's, source fact extraction's, bible fact extraction's, the deep continuity check's and 4.3's three book-level prompts' — `book_level` also running 4.4's tie-break)
on `secrets.ANTHROPIC_API_KEY` and uploads them as an artifact, committing
nothing (`tests/unit/evals-workflow.test.ts`); `injection-redteam.yml`
(**Injection red-team**, nightly once the repository variable
`INJECTION_REDTEAM_ENABLED` is `true`, and on dispatch; not a check) runs the
prompt-injection corpus against the real model with the same properties
(`tests/unit/injection-redteam-workflow.test.ts`).

## Stack

Node 24, Next.js 16 (App Router), React 19, TypeScript strict, Tailwind 4,
Prisma 7 with a multi-file schema folder, Zod 4, `@t3-oss/env-nextjs`, Jest 30,
Playwright, ESLint 9 flat config. Versions are kept in step with
inflect-compliance; read the exact ones off `package.json`. tldraw (Phase 3.1)
stays pinned to 3.x with the watermark on (decision D1).

## Layer structure

```
src/app/api/            → route handlers: the HTTP boundary only (parse input, call a usecase, shape the response)
src/app-layer/usecases/ → business logic orchestration (validate → policy → repository → event)
src/app-layer/policies/ → authorization checks, always called before data access
src/app-layer/repositories/ → Prisma queries; every workspace-scoped query filters by workspaceId
src/lib/                → shared infrastructure (db, later auth, observability, storage, AI seam)
src/env.ts, src/env-client.ts → the server and client env modules
src/components/         → React components (ui/ primitives, layout/ shells, command-palette/, theme/)
packages/ui/            → @inkquisitor/ui, the workspace package of product-neutral primitives
messages/en.json        → next-intl catalogue (English only)
prisma/schema/          → multi-file Prisma schema; base.prisma owns the generator and datasource
```

A call goes `app/api → usecases → policies → repositories`, never sideways or
backwards: a route handler does not import a repository or Prisma, and a
repository does not authorize. Phase 0.4 added:

```
src/app-layer/types.ts       → RequestContext (workspace fields optional) and WorkspaceRequestContext (required)
src/app-layer/jobs/          → BullMQ: types, queue (enqueue), executor-registry, schedules, scheduler, worker
src/lib/observability/       → pino logger + redaction, request context, OTel, Sentry, shutdown, job runner
src/lib/errors/              → typed errors and withApiErrorHandling (every product route handler is wrapped in it; the probes are not)
src/lib/security/, rate-limit/ → the three rate-limit tiers
src/lib/storage/             → local / S3 providers, workspace object keys, ClamAV scan
src/lib/{mailer,redis,startup-checks}.ts, src/lib/http/, src/lib/health/
src/proxy.ts                 → Next 16 proxy (Node runtime): auth + read rate-limit tiers, x-request-id, the workspace gate (0.3), CSP + security headers (0.H)
scripts/worker.ts            → the worker process (bundled by scripts/build-worker.mjs)
eslint-rules/                → the local ESLint plugin (`local/…`)
site/                        → the Starlight help site, publishing docs/user/ only
```

Phase 0.3 (identity, workspaces, RLS) added:

```
src/auth.ts                  → next-auth 4: Credentials + Google (when configured), JWT sessions backed by UserSession
src/app-layer/context.ts     → getWorkspaceCtx / getWorkspacePageCtx / getUserCtx: session + DB membership → RequestContext
src/app-layer/usecases/      → sign-up (and Google provisioning), members, sessions
src/app-layer/policies/      → assertPermission (audits AUTHZ_DENIED, then a generic 403)
src/app-layer/repositories/  → user, workspace (createWorkspaceWithDek), membership
src/app-layer/events/audit.ts → logEvent(ctx, …), the one writer API of the audit trail
src/lib/auth/                → passwords, credentials (lockout), session-revoked, workspace-gate (proxy), membership claims, redirect-path
src/lib/db/                  → rls-middleware (runInWorkspaceContext, runWithoutRls), rls-tripwire, db-context, encryption-middleware
src/lib/security/            → encryption, workspace keys, encrypted-fields manifest, sentinel, session-tracker, password-check (HIBP), permission-middleware
src/lib/audit/               → the hash-chained audit writer and user-level auth events
src/app/login, signup, signout, no-workspace; src/app/w/[workspaceSlug]/ (books, settings)
```

Phase 0.H (hardening) added:

```
src/lib/security/csp.ts      → the CSP (nonce + strict-dynamic) and the security headers
src/lib/http/client-ip.ts    → the one client-address rule every rate-limit tier keys on (TRUSTED_PROXY_HOPS)
src/lib/security/progressive-lockout.ts → the sign-in lockout over a shared store (Upstash / Redis / memory)
prisma/migrations/…_workspace_last_owner_guard → the database's last-OWNER trigger
scripts/check-build.js       → CI's Build check over the build output and bundles
scripts/carve-audit.mjs      → the carve-manifest audit against an inflect checkout
tests/helpers/api-routes.ts, client-import-graph.ts → the route classes and the import-graph walk the guards share
```

Phase 1.1 (the book bible) added:

```
prisma/schema/bible.prisma   → Book, BibleElement, BibleField, BibleRelation, BibleEntryVersion (append-only)
src/lib/bible/               → kinds (client-safe enum lists), templates/<kind>.json + the registry (templates.ts,
                               template-schema.ts), field-values (type checks + sanitising), snapshot, slug, text
src/lib/security/sanitize.ts → sanitizePlainText / sanitizeRichTextHtml (sanitize-html), the write-path sanitiser
src/app-layer/schemas/bible.ts → the bible API's request shapes (Zod, strict)
src/app-layer/repositories/  → book, bible (elements, fields, relations, versions)
src/app-layer/usecases/      → books, bible-elements, bible-relations, bible-versions; bible-common (the versioned save)
src/app/api/w/[workspaceSlug]/books/** → books, elements, fields, relations, versions, restore
src/lib/http/json-body.ts    → readJsonBody: a malformed body is a 400, never a 500
```

Phase 1.2 (the bible UI) added:

```
src/app/w/[workspaceSlug]/books/**  → books list, book home (the kind board), element page
src/components/bible/        → BooksList, BookBoard, ElementPage, FieldEditor, RelationsPanel, HistoryPanel,
                               the create modals, use-element-autosave
src/lib/bible/               → api-client (client URL table + fetch), ui-model (template views for pages),
                               completeness, snapshot-text (a snapshot as diff lines), page-data (404)
```

Subphase 2.0 (the vector store, D7 and D8) added:

```
deploy/postgres/             → the Postgres image (postgres:16-alpine + pgvector v0.8.7 by tag and commit, gosu rebuilt), smoke.sh, CI's start.sh
prisma/schema/vector.prisma  → VectorEmbedding: vectors only, one table for every revision and source model
src/app-layer/repositories/vector.repository.ts → the ONE way into the store (getVectorRepository); backends under vector/
src/lib/ai/in-deployment-service.ts → the in-deployment address rule and the pinned, bounded dial
src/lib/ai/embeddings/       → provider contract, stub (dev/test default), TEI (production), config, revision, vectorContentHash
```

Phase 1.3 (bible import and export) added:

```
src/lib/archive/zip.ts       → writeZip (fflate, deterministic) and readZip (bounded, refuses by name)
src/lib/bible/bundle-format.ts → the Markdown bundle's files; frontmatter split and safe YAML read
src/lib/bible/bible-pdf.ts, src/lib/pdf/ → the bible as a PDF on the lifted pdfkit helpers (pdfKitFactory, layout; fonts and text since #24)
fonts/noto-sans/             → the PDF's embedded font (Noto Sans 2.015, OFL), read from <cwd> at run time
src/app-layer/usecases/      → bible-export (bundle, PDF), bible-import (bundle, concept note)
src/app/api/w/[workspaceSlug]/books/[bookId]/export/{bundle,pdf}, import/{bundle,concept-note}
src/lib/http/bounded-body.ts → readBoundedBytes: the bounded body read readJsonBody shares
src/components/bible/        → ImportModal, import-messages; export links on BookBoard
```

Phase 1.H (hardening Phase 1) added:

```
prisma/migrations/…_bible_hardening → Book.deletedAt, the list indexes, the purge-window trigger
src/lib/bible/book-retention.ts    → the 30-day restore window (client-safe)
src/app-layer/usecases/            → book-purge (the daily job's work), bible-pages (what each page reads)
src/app/api/w/[workspaceSlug]/deleted-books/** → the recently deleted list, restore
src/components/bible/              → DeleteBookModal, DeletedBooksList, use-export-download
src/app/w/[workspaceSlug]/deleted-books/ → the OWNER's Recently deleted page
tests/guards/schema-index-coverage, find-many-bounded; tests/helpers/prisma-schema-models, bible-load
```

Phase 2.1 (the model layer) added:

```
src/lib/ai/client.ts         → clientForRun: the ONE file that loads @anthropic-ai/sdk; the messages-only middleware
src/lib/ai/call-structured.ts → callStructured: one streamed, Zod-validated call (guard, ceiling, one repair, one record)
src/lib/ai/prompt.ts         → definePrompt, the nonce fence (fenceData), the request and repair builders
src/lib/ai/{tiers,model-capabilities,pricing,config,errors,call-record}.ts, src/lib/ai/guard/ (lifted scanners + thin wrapper)
src/app-layer/usecases/model-calls.ts → callStructured(ctx, …) bound to the workspace's ledger
src/app-layer/repositories/ai-call.repository.ts, prisma/schema/ai.prisma → AiCallLog, AiSpendMonth, AiSpendReservation
tests/helpers/fake-anthropic.ts → the fake Messages API the SDK is handed as its fetch
```

Phase 2.2 (the question engine) added:

```
prisma/schema/interview.prisma → InterviewSession, InterviewRound, Question, Answer (append-only)
src/lib/interview/           → the pure core: frontier, plan, candidates (output schema + validation), dedupe, text
                               (normalise, grounding), round (produceRound), stop, dials, packs (+ packs/**), prompt
                               (the 2.1 template + data blocks), storage, generator (interface, GenerationStop),
                               model-seam.ts (THE wiring to 2.1's callStructured), evals/ (coverage set + runner)
prisma/migrations/…_ai_retention_mode → AiCallLog's RETENTION_MODE_UNDECLARED code (D5 amended)
tests/helpers/fake-question-model.ts → the fake Messages API turn that answers the engine's prompt
src/app-layer/usecases/      → interviews, interview-answers, interview-rounds, interview-state, question-embeddings
src/app/api/w/[workspaceSlug]/books/[bookId]/interviews/** → start, list, read, next round, close, stop, answer, skip, decide later
```

Phase 2.3 (dials, personas, pack mounting) added:

```
src/lib/interview/dial-settings.ts → DialSettings, resolveDials (session > book > workspace > code), dialEffects
src/lib/interview/pack-text-scan.ts, pack-evaluation.ts, pack-mount.ts, pack-records-config.ts → the lifted skill mount system
src/lib/interview/packs/**/evaluation-record.json, packs/personas/situations.json → records; the persona situations
src/lib/interview/evals/structural-generator.ts, run-evaluations.ts; scripts/evaluate-packs.ts → npm run packs:evaluate
prisma/migrations/…_interview_dials_and_packs → packPins (write-once), personas ≤ 3, Workspace/BookInterviewDefaults, PACK_CHANGED
src/app-layer/usecases/      → interview-defaults, interview-packs
src/app/api/w/[workspaceSlug]/interview-packs, interview-defaults, books/[bookId]/interview-defaults
src/lib/ai/anthropic-workspace.ts → ANTHROPIC_WORKSPACE_ID, the header an organisation-level key needs
.github/workflows/evals.yml  → real-model evaluation records (dispatch only, artifact, no push)
```

Phase 2.4 (the interview experience) added:

```
src/components/interview/    → InterviewSetupSheet, InterviewLauncher, InterviewSession, QuestionCard, RoundFieldsPanel,
                               InterviewsList, use-interview-stream (lifted), messages (stop reasons and refusals in words)
src/lib/interview/           → stream-events (SSE contract, lifted), stream-response (transport), rephrase, setup (THE 2.3 SEAM),
                               api-client, page-model
src/lib/ai/model-stub.ts     → the stubbed model (AI_MODEL_STUB=1): a local test server's in-process Messages API
src/app-layer/usecases/      → interview-rephrase, interview-pages
src/app/api/w/[workspaceSlug]/books/[bookId]/interviews/{stream,[sessionId]/rounds/stream,…/rephrase}
src/app/w/[workspaceSlug]/books/[bookId]/interviews/{page,new,[sessionId]}
tests/e2e/stub-server.ts     → the second E2E server (E2E_PORT + 2) with the stubbed model
```

Phase 2.5 (enrichment) added:

```
prisma/schema/enrichment.prisma → ReconcileRun, EnrichmentProposal (text encrypted, fixed but for its one decision), EnrichmentCitation
src/lib/enrichment/          → the pure core: vocabulary, schema (output), validate (THE rules), prompt (RECONCILE_PROMPT), reconcile
                               (runReconcileStep), reconciler (interface), model-seam.ts (THE wiring to 2.1), storage, review-rules,
                               record-gate (D11 for reconcile), api-client; evals/ (enrichment.json, adversarial.json, eval-set,
                               evaluation: replay grader, reference reconciler, records; evaluation-record.json)
src/app-layer/usecases/      → enrichment-reconcile (the run; close/stop wrappers), enrichment-review (reads, accept, reject, bulk)
src/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/{proposals/**,rounds/[roundNumber]/reconcile}
src/app/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/review → the review page (src/components/enrichment/SessionReview)
```

Phase 2.6 (the research agent, D9) added:

```
prisma/schema/research.prisma → ResearchBrief, ResearchSource, ResearchRun, ResearchFinding, ResearchCitation, ResearchProposal(+Finding), ResearchEgress (D15)
src/lib/ai/server-tool-loop.ts → runServerToolLoop: the web tools' pause_turn loop (one AiCallLog row a request, the tripwire)
src/lib/research/            → the pure core: vocabulary (depth budgets, outcomes), query-egress (THE egress check), sources
                               (quoteFound), prompt (GATHER / FINDINGS / FIT), schema, validate, run (runResearchSteps), researcher,
                               model-seam.ts (THE wiring to 2.1), storage, record-gate, stream-*, api-client; evals/ (research.json,
                               adversarial.json, evaluation: replay grader over a fake web; evaluation-record.json)
src/app-layer/usecases/      → research-briefs (create, attach, dispatch), research-run (the job's work), research-review, research-pages
src/app-layer/jobs/          → `research-run`, one job per run, addressed by id
src/app/api/w/[workspaceSlug]/books/[bookId]/research/** → briefs, sources, runs (+ stream), keep finding, accept / reject proposal
src/app/w/[workspaceSlug]/books/[bookId]/research → the Research page (src/components/research/ResearchPage)
```

Phase 2.H (hardening Phase 2, security and privacy) added:

```
src/lib/redteam/             → the prompt-injection corpus and suite (injection-corpus.json, corpus, injection-suite); scripts/injection-redteam.ts
src/lib/text/                → prompt-disclosure (eight words of a prompt), negation (polarityKept), url-mentions (addressesIn)
src/lib/ai/call-log-retention.ts, src/app-layer/usecases/ai-call-retention.ts → AiCallLog's retention and its daily job
src/lib/bible/picker-query.ts → the relation picker's clamped search
```

Phase 2.H (robustness, cost and evaluation records) added:

```
src/lib/http/stream-capacity.ts   → per-workspace (4) and per-process (32) stream slots, carved from inflect (takeStreamSlot)
src/lib/security/model-call-rate-limit.ts → chargeModelCalls: model calls a minute per workspace (429 MODEL_RATE_LIMITED)
src/lib/ai/prompt-hash.ts         → promptContentHash: what a record pins besides the version
src/lib/evals/judge.ts            → the evaluation-time judge (model in Evals, structural fallback), never in a product path
src/lib/interview/evals/rephrase* → the rephrase prompt's set, evaluation and record (no production gate: D17)
src/lib/interview/repetition.ts, dedupe-thresholds.ts; src/lib/process-shared-cache.ts; src/lib/bible/field-coercion.ts
tests/guards/evaluation-records-current.test.ts → every prompt and pack hash recomputed against its committed record
```

Phase 3.1 (the canvas platform, D1 and D18) added:

```
prisma/schema/canvas.prisma  → StoryMap (one per book and kind), MapNode (a BibleElement drawn), MapEdge (a BibleRelation drawn), MapSnapshot (append-only)
src/components/canvas/tldraw/ → story node / edge shape utils, edge binding util, serializer (THE round trip), edge-validation,
                               arrow-to-edge, editor-canvas, auto-layout-host (dagre), restore-freeform, add-element-node,
                               rich-text-extensions (tldraw's TipTap list under the override, D20)
src/components/canvas/       → StoryMapCanvas (tldraw host), StoryMapEditor (the dynamic chunk), StoryMapWorkspace (no tldraw),
                               CanvasErrorBoundary, CanvasHistorySidebar, CanvasDiffOverlay, CanvasExportMenu, MapConflictNotice, AddElementPicker
src/lib/canvas/              → map-kinds, limits, shape-types, freeform (sanitiser), map-state (canonical), canvas-diff, canvas-changes(-tldraw),
                               use-canvas-autosave, use-map-autosave, map-save, canvas-export, display, tldraw-assets, api-client
src/app-layer/usecases/story-maps.ts, repositories/story-map.repository.ts, schemas/canvas.ts
src/app/api/w/[workspaceSlug]/books/[bookId]/maps/[kind]/** → map GET/PUT, snapshots, snapshot, restore
src/app/api/canvas-assets/[...asset] → tldraw's fonts, icons and translation from @tldraw/assets (public)
src/app/w/[workspaceSlug]/books/[bookId]/maps/[kind] → the map page
```

Phase 3.2 (the three maps, D22) added:

```
prisma/migrations/…_plot_beat_kind, …_story_order → PLOT_BEAT; BibleElement.orderRank (+ unique, CHECK); BibleEntryVersion.movedInOrder
src/lib/bible/templates/plot_beat.json, src/lib/interview/packs/craft/plot_beat/ → the kind and its craft pack
src/lib/bible/story-order.ts → fractional ranks (rankBetween, placeRank); ORDERED_KINDS in kinds.ts
src/app-layer/usecases/bible-order.ts, …/elements/[elementId]/order → the order move
src/lib/canvas/lanes.ts, relation-picker.ts → derived layout, drop and keyboard moves; the type picker's choices
src/components/canvas/ → RelationTypePicker, ElementSheet, LaneBackdrop, StoryMapPreview (SVG, no tldraw), tldraw/lane-host
```

Phase 3.3 (interview from the canvas, D24) added:

```
prisma/schema/bible.prisma   → BibleRelationField (a relation's fields), BibleRelationVersion (its own append-only history)
src/lib/bible/relation-snapshot.ts, src/app-layer/usecases/relation-common.ts → a relation's versioned field save
src/lib/interview/subjects.ts, packs/relations/ → a question's subject (element, relation, the beat not yet created); the relations pack
src/app-layer/usecases/interview-scope.ts → SELECTION ("Grill this") and BETWEEN ("What happens between these?")
src/lib/canvas/structure-preview.ts → ghost geometry, the plot board's slots (pure)
src/components/canvas/       → GhostLayer (OnTheCanvas, never records), CanvasInterviewControls, PendingStructureList
src/components/enrichment/StructuralProposals.tsx, src/components/bible/RelationSheet.tsx
src/app/api/w/[workspaceSlug]/books/[bookId]/{relations/[relationId]/fields, proposals/pending-structure}
```

Phase 3.4 (word search, D21) added:

```
src/lib/search/              → porter2 (Snowball English, PORTER2_VERSION), irregular (the reviewed table), analyse (normalise,
                               Intl.Segmenter tokens, foldText), plain-text (HtmlTextReader), query (parser), rank (needles, BM25F,
                               snippets, counted work), vocabulary (bounds, weights, wire types; client-safe)
src/app-layer/usecases/book-search.ts, schemas/search.ts → searchBook, readSearchDocuments (decrypt and scan, stores nothing)
src/app/api/w/[workspaceSlug]/books/[bookId]/search → POST { q } (a body, never a query string)
src/components/search/BookSearch.tsx → the board's search box and highlighted results
tests/fixtures/snowball/     → Snowball's English voc.txt / output.txt (BSD-3), golden-pin.json
```

Phase 3.H (hardening the canvas, story order and canvas interviews) added:

```
src/lib/canvas/auto-layout-off-thread.ts, auto-layout-worker.ts, auto-layout-worker-factory.ts → dagre in a Web Worker (main-thread fallback)
src/components/canvas/StoryMapListView.tsx → the map as a list: every canvas action by keyboard and screen reader
prisma/migrations/…_canvas_hardening → a snapshot names the map's current version; one cascade-marker setting
scripts/bundle-budget.json   → per-route first-load budget (gzipped JS + CSS), held by scripts/check-build.js
tests/helpers/random-graph.ts → seeded random maps for the round-trip property tests
src/app-layer/usecases/story-slot.ts → a BETWEEN slot: how it changed, where its beat may go, the beat it holds (D25)
src/lib/text/truncate.ts     → truncateGraphemes: display text cut between grapheme clusters
```

Phase 4.0 (the source library and ingestion, D23 and D26) added:

```
prisma/schema/sources.prisma → SourceLibrary (a book's, or the workspace's series library), Source (a file kept as chunks), SourceChunk
                               (encrypted, a vector source), StoryFact (the 4.1 fact model), BookSeriesSource (opt-in), StoryFactOverride
src/lib/sources/             → vocabulary (bounds, outcomes, THE predicate → field table; client-safe), parse (sniff + DOCX/EPUB/PDF/MD/TXT),
                               document (blocks), chunk, parse-worker (THE bounded worker) with pdf-text and docx-text (+ scripts/{pdf,docx}-text-worker.mjs), quote (THE span check), prompt
                               (EXTRACT_PROMPT), schema, validate (THE fact rules), cost, extractor, model-seam.ts (THE wiring to 2.1),
                               record-gate (D11), view-token (bulk confirm), storage (sanitisers), api-client; evals/ (set, evaluation, record)
src/app-layer/usecases/      → source-library (upload, list, remove, opt-in, dispatch), source-ingest (the job's work), source-facts
                               (review, decide, bulk, override), source-retrieval (the frontier's check, the retriever), source-common, source-pages
src/app-layer/jobs/          → `source-ingest`, one job per dispatch, addressed by id
src/app/api/w/[workspaceSlug]/{books/[bookId]/{sources,series-sources,facts},series/{sources,facts},sources/[sourceId],facts/**}
src/app/w/[workspaceSlug]/{books/[bookId]/{sources,facts},series,series/facts} → src/components/sources/{SourcesPage,FactsReview}
```

Phase 4.1 (the fact layer and retrieval, D27) added:

```
prisma/schema/sources.prisma → StoryFact's kinds (SOURCE_CHUNK, BIBLE_VERSION, RELATION_VERSION) and columns, StoryFactProvenance,
                               StoryFactProposal (the invalidation record 4.2 extends), BibleFactExtraction (THE outbox), EmbeddingTask
src/lib/facts/               → vocabulary (client-safe), entry-text (a version as sections; what changed), prompt (BIBLE_FACTS_PROMPT,
                               graphiti's design), schema, validate, dedupe (claimParts, resolveFacts: THE rules), claim-key, model-seam.ts
                               (THE wiring to 2.1), record-gate (D11); evals/ (five synthetic bibles, evaluation, record)
src/app-layer/usecases/      → bible-facts (the `bible-facts` job's work), fact-layer-dispatch (the minutely dispatcher: extractions, embeddings),
                               fact-proposals (review), source-retrieval (the bible check, the budgeted context)
src/app-layer/repositories/fact-layer.repository.ts; vector/ `within` (the allowed set in the query) and `presentSources`
src/app-layer/jobs/          → `fact-layer-dispatch` (every minute), `bible-facts` (one per due outbox row), shutdown-signal (#57 item 6)
src/app/api/w/[workspaceSlug]/books/[bookId]/fact-proposals/** (decided on the Continuity page since 4.2)
```

Phase 4.2 (continuity checks and open threads, D28) added:

```
prisma/schema/continuity.prisma → ContinuityCheck (a book's pass and cursor), ContinuityRun, StoryThread (PROMISE / CLUE / OPEN_QUESTION),
                               StoryThreadProposal, StaleFlag; StoryFactProposal's kind / DEEP / checkRunId; StoryFact AUTHOR_RESOLUTION
src/lib/continuity/          → vocabulary (bounds, kinds, outcomes; client-safe), story-clock (D25 ranks), rules (THE detectors), night-plan,
                               prompt / schema / validate / cost (CONTINUITY_PROMPT, deep tier), model-seam.ts (THE wiring to 2.1),
                               record-gate (D11), storage (sanitisers), cited, change-text, api-client; evals/ (set, evaluation, record)
src/app-layer/usecases/      → continuity (the page, threads, decisions, dismissals), continuity-check (the nightly job's work),
                               continuity-dispatch (the dispatcher), stale-flags; fact-proposals (resolution, AUTHOR_RESOLUTION facts)
src/app-layer/jobs/          → `continuity-dispatch` (02:23 UTC), `continuity-check` (one per changed book, by run id)
src/app/api/w/[workspaceSlug]/books/[bookId]/{continuity,threads/**,thread-proposals/**,stale-flags/**}
src/app/w/[workspaceSlug]/books/[bookId]/continuity → src/components/continuity/ContinuityPage
```

Phase 4.3 (book-level interrogation, D29) added:

```
prisma/schema/interrogation.prisma → StressTest (a run; status, outcome, coverage, confirmed "at most"), StressWeakPoint (encrypted,
                               append-only), GapHunt (candidates, encrypted picks; newest five a book), InterviewCompaction (encrypted
                               summary, append-only); InterviewSession.stressTestId
src/lib/stress-test/         → vocabulary (client-safe), input (THE bounded canon, tags, coverage), prompt (STRESS_TEST_PROMPT, deep),
                               schema, validate (THE weak-point rules), cost (fitStressInput), model-seam.ts, record-gate (D11),
                               storage; evals/ (set, evaluation, record)
src/lib/gap-hunt/            → vocabulary, candidates (THE score, code), prompt (GAP_RANK_PROMPT, balanced), schema, validate,
                               sessions (the three proposed, client-safe), cost, model-seam.ts, record-gate, storage; evals/
src/lib/interview/           → compaction (THE state block), compaction-prompt (COMPACTION_PROMPT, fast; validateRoundsSummary),
                               compaction-seam, compaction-gate, persona-groups; packs/personas/panel-{target-reader,ruthless-editor,
                               genre-specialist}/ (each with its own situations.json); evals/compaction*
src/app-layer/usecases/      → stress-tests (page, start, the job's work, a session's scope), gap-hunts, interview-compaction
src/app-layer/jobs/          → `stress-test`, one job per confirmed run, addressed by id
src/app/api/w/[workspaceSlug]/books/[bookId]/{stress-tests/**,gap-hunts}
src/app/w/[workspaceSlug]/books/[bookId]/interrogate → src/components/interrogation/InterrogatePage
```

Phase 4.4 (continuous, deep questioning, D23 and D30) added:

```
prisma/migrations/…_continuous_questioning(_enums) → QuestionGenerator, InterviewLengthMode, QUESTION_BUDGET / VALUE_FELL / AWAITING_DECISIONS /
                               SESSION_LIMIT, origin GENERATOR; the session's length and generatorsOff, Question's generator columns,
                               StoryFact.decidedByAnswerId; the six-round CHECK replaced
src/lib/interview/generators/ → index (THE generators: frontier, ladder, relations, sources, continuity; pure), value (THE score),
                               wording (code-worded questions), select (THE validate / dedupe / order / cut), ladder-depth
src/lib/interview/session-length.ts → rounds, questions or until I stop; the token budget from the length (client-safe)
src/lib/interview/question-order/ → the tie-break: prompt (QUESTION_ORDER_PROMPT, fast), schema, validate (exact permutation),
                               cost, model-seam.ts, record-gate (D11); evals/ (set, evaluation, record)
src/app-layer/usecases/      → interview-generators (THE generator inputs, bounded), interview-question-order (the tie-break's call);
                               interview-rounds (planSession, the hard repetition gate), source-facts (decideFactsFromRound)
```

Phase 4.H-a (hardening Phase 4: correctness and isolation, D31) added:

```
prisma/migrations/…_phase4_hardening → ContinuityRun.nightKey (one run a book a night), ContinuityCheck.pageFailures / parkedSubjects,
                               Answer (workspaceId, id), composite keys for Question.storyFactId and StoryFact.decidedByAnswerId
src/lib/evals/record-gate-reports.ts → every model feature's D11 gate report, written at start (GATE_REPORTS, #63)
tests/fixtures/workers/native-spike-worker.mjs → a parse worker held in one native call (the memory watchdog's test)
tests/integration/{fact-layer,continuity,questioning}-hardening, retrieval-isolation, embedding-deletion; tests/rendered/phase4-not-assessed
```

## Rules every change obeys

These are `docs/ROADMAP.md` section 3, restated. The roadmap is authoritative
if the two ever differ.

1. **The author decides.** No model output changes a bible entry until the author accepts it. Every accepted change is a new version naming the answers it came from.
2. **Grounded enrichment.** A proposed bible change cites the answer(s) it is drawn from. A sentence with no source is refused, not softened.
3. **One file loads the model SDK** (`clientForRun`), enforced by the lifted ESLint rule.
4. **Author text is untrusted input to the model** (guard-scanned, fenced as data) and private data everywhere else (encrypted at rest, never logged, never in analytics).
5. **Never ask what the bible already answers.** The frontier is computed against stored facts first.
6. **Zero is never complete.** A readiness figure over no questions, no scenes or no checks reads "not assessed", never 100%.
7. **Licence hygiene.** No code or question text from the inspiration-only list. Each lifted file is recorded in `docs/carve-manifest.md` with its source path and commit.
8. **One pull request per subphase**, with tests that fail when the behaviour regresses. Each phase ends with a hardening subphase that must close before the next phase starts.
9. **Every model feature has an evaluation set** and a cost budget per call, recorded with the prompt version.

And the owner's standing positions: the AI never writes manuscript prose (D3);
one workspace per author with OWNER / EDITOR / READER memberships and
row-level security from day one (D4); author text reaches the model provider
only under zero-retention terms, standard retention being permitted during a
closed beta with an explicit operator flag (D5, amended 2026-11-19).

## Conventions

- **Environment.** Server variables are declared in `src/env.ts` and read as
  `env.X`, never `process.env.X` (tooling configs such as `prisma.config.ts`
  and `playwright.config.ts` are the exception). `NEXT_PUBLIC_` variables live
  in `src/env-client.ts`, the only env module a `'use client'` file, or any
  module one can reach transitively, may import
  (`tests/guards/client-reachable-modules-import-no-server-env.test.ts`; the
  build's client chunks are checked by `scripts/check-build.js`). Add a variable
  in the same change as the code that reads it, and list it in `.env.example`
  (`tests/unit/env-example.test.ts`). `SKIP_ENV_VALIDATION=1` skips validation
  for builds and tests; never put a real secret in CI or an image.
- **Database.** `DATABASE_URL` is the runtime connection (PgBouncer in the
  compose stack); `DIRECT_DATABASE_URL` is for `prisma migrate`, read by
  `prisma.config.ts`, which loads `.env` itself because the Prisma 7 CLI does
  not. Every port `docker-compose.yml` publishes is bound to 127.0.0.1.
  Prisma 7 needs a driver adapter: construct clients through `src/lib/db.ts`. New models go in a domain file under
  `prisma/schema/`, never in `base.prisma`.
- **Logging.** No `console.*` in server code, `src/` and `scripts/*.ts` (ESLint
  error, and a source scan in `eslint-rules/__tests__/no-console.config.test.ts`;
  the edge logger is the one exception). Log through `logger` from `@/lib/observability/logger`
  (`edgeLogger` in the proxy). Author text never reaches a log line, an error
  report or a job payload: `local/no-raw-prompt-logging` refuses a
  content-named field (`answer`, `text`, `content`, `body`, `prompt`, …) at a
  log or `captureError` call, and `src/lib/observability/redaction.ts` redacts
  those names and every credential name as the second line. Log ids, counts
  and lengths. `withApiErrorHandling` never logs a request body.
- **Platform services.** Every new environment variable is optional with a
  safe development default; what production cannot run without goes in
  `src/lib/startup-checks.ts`, which the web tier (`src/instrumentation-node.ts`)
  and the worker both enforce. Mutations are rate-limited by
  `withApiErrorHandling` (`API_MUTATION_LIMIT`), GETs under `/api/` and
  `/api/auth/**` in the proxy; storage is in-memory unless both Upstash
  variables are set. Every tier keys on ONE client address,
  `clientIpFrom` (`src/lib/http/client-ip.ts`): the X-Forwarded-For entry
  `TRUSTED_PROXY_HOPS` (default 1: Caddy) positions from the right, never the
  client-written leftmost entry or `x-real-ip`; `0` trusts no header and every
  request shares one bucket. The address is parsed and written canonically (a
  malformed one is the shared bucket; IPv4-mapped IPv6 is the IPv4 address),
  and the tiers key on `clientRateLimitKeyFrom`, which masks IPv6 to its /64;
  never add a client-chosen value (a User-Agent, a header) to a key. The
  sign-in lockout counts attempts in a store every process shares
  (`src/lib/security/progressive-lockout.ts`: Upstash when configured, Redis in
  production, memory only in development and test; a failing store degrades to
  memory), and reserves each attempt BEFORE its verify in one atomic step (a
  Lua script on Redis and Upstash) whose count gates it — never read the count
  and record afterwards. The proxy's import graph stays free of
  Node-only modules (`tests/guards/proxy-imports-no-node-only-module.test.ts`):
  Upstash is imported from `@upstash/redis/cloudflare`, never the package root.
  Close a Redis client with `closeRedisClient` (`src/lib/redis.ts`), never a bare
  `disconnect()`, which leaves ioredis's 2-second socket timer running. No module-scope `setInterval` (`tests/guards/no-module-scope-timers.test.ts`):
  sweep lazily on a caller's turn. A job payload names rows by id; a new job
  extends `JobPayloadMap`, `JOB_DEFAULTS` and the executor registry. Object
  keys are `workspaces/<workspaceId>/…` (`buildWorkspaceObjectKey`) and are
  checked with `assertWorkspaceKey` before use. A URL handed outside the
  process comes from `publicBaseUrl()` (APP_URL), never the request host.
- **Routes and workspaces.** Every app page lives under `/w/[workspaceSlug]/`
  and every workspace API route under `/api/w/[workspaceSlug]/` (an author may
  belong to more than one workspace later, D4). Build links from
  `APP_ROUTES` (`src/lib/app-routes.ts`), never a literal. `/` sends a
  signed-in person to their first workspace and shows the landing page
  otherwise; sign-in pages are `/login`, `/signup`, `/signout`, `/no-workspace`.
  The proxy gates `/w/**` and `/api/w/**` on the JWT's `memberships`
  claim (capped at 50, `membershipsTruncated` defers to the server) over every
  spelling of the path (`src/lib/auth/workspace-gate.ts`); it is a pre-filter.
  The authority is the DATABASE check in `getWorkspaceCtx` (API) and the
  workspace layout (`getCurrentWorkspace`), which treat a missing workspace and
  a non-member alike (404 / `/no-workspace`). A workspace usecase takes a
  `WorkspaceRequestContext` as its first argument, built only there.
- **Authorization.** A workspace route is
  `withApiErrorHandling(requirePermission('<key>', handler))`; a usecase also
  asks `assertPermission(ctx, '<key>')`. Keys come from `PermissionSet`
  (`src/lib/permissions.ts`: OWNER, EDITOR, READER), never a role name. A denial
  writes AUTHZ_DENIED to the audit trail and returns a generic 403 naming no
  key; if the row cannot be written the request fails 500. Self-service account
  routes (`/api/account/**`) use `getUserCtx` and bind every query to the
  caller: the handler is `withApiErrorHandling(async (req) => { const ctx =
  await getUserCtx(req); … })`, that statement first and exactly. Every
  route-handler file (any `route.*` under an app directory, anything under
  `pages/api`) is in one class (`tests/helpers/api-routes.ts`: a `.ts` route
  under `src/app/api/w/[workspaceSlug]/` or `src/app/api/account/`, or the
  closed `PUBLIC_ROUTES` list with a reason), and exports each handler as
  `export const <METHOD> = …` (a destructured, `let`/`var`, default or
  re-exported handler fails the guard);
  `tests/guards/api-route-authorization.test.ts` checks the shape and
  `tests/integration/api-route-authorization.test.ts` calls every handler
  signed out (401), as a stranger (404) and as a READER (403).
- **Authentication.** Credentials go through `authenticateWithPassword` only
  (bcrypt over the password itself, which is refused past 72 UTF-8 bytes rather than
  truncated — never a fast digest of a password first; progressive lockout per email, one bcrypt
  compare on every failure path so timing does not enumerate; the failure's
  audit row is never awaited, at most one per user per lockout window, none for
  a lockout refusal). Sign-up runs the
  password policy and the HIBP check (`PASSWORD_BREACH_CHECK=off` skips it;
  tests inject `breachCheck` and never reach the network) and provisions the
  user, the workspace with its data key and the OWNER membership in ONE
  transaction. Google signs in only an address Google verified, and claims an
  unverified password account. Every sign-in records a `UserSession`; the `jwt`
  callback verifies it on every pass and THROWS `SessionRevokedError` for a
  revoked, expired or missing row or a bumped `sessionVersion` — never a flag.
- **Row-level security.** Every model with a `workspaceId` (and `Workspace`)
  has FORCE RLS, a `workspace_isolation` policy (USING and WITH CHECK) and
  `superuser_bypass`, in its migration, and is reached only through
  `runInWorkspaceContext` (as `app_user`). Every other model is listed in
  `GLOBAL_MODELS` with a reason. `runWithoutRls` takes a reason from a closed
  list. See `docs/rls-workspace-isolation.md`; both coverage tests compare the
  policies exactly (not by substring) and the live one proves isolation per
  table. `app_user` reads only `id`, `name`, `email` of `User` and writes none
  of it; a new column read in a workspace context is a grant in a migration.
- **Field encryption.** Author text is encrypted at rest by listing its column
  in `src/lib/security/encrypted-fields.ts` (since Phase 1.1: the bible's
  logline, summary, field value, relation note, version snapshot and change
  summary), never by calling the primitives: inside a workspace context a
  manifest field is a `v2:` envelope under the workspace's data key (`createWorkspaceWithDek` makes one
  per workspace, wrapped under `DATA_ENCRYPTION_KEY`). A field is encrypted only
  on the model that lists it (nested writes and includes resolve their model
  from the DMMF); every value is sealed, with no "already an envelope" skip;
  `runInWorkspaceContext` resolves the key before opening its transaction.
  The extension seals strings only, so a JSON document (the version
  snapshot) is serialised to a string column first and sealed whole.
  Production refuses to
  start without `DATA_ENCRYPTION_KEY` and `AUTH_SECRET`; the web tier and the
  worker run an encrypt → decrypt sentinel at boot.
- **Audit trail.** Write through `logEvent(ctx, …)` (pass `{ db }` to commit
  with the change). Rows are hash-chained per workspace and append-only (a
  trigger refuses UPDATE, DELETE and TRUNCATE for every role); details carry
  ids, counts and codes, never author text or an email. Sign-in events are
  appended to each of the user's workspaces (`recordUserAuthEvent`).
- **Last OWNER.** A workspace always keeps an OWNER: the usecase refuses
  (`members.ts`, under `pg_advisory_xact_lock(hashtext('workspace-owner:' ||
  workspaceId))`) and so does the database, whoever writes
  (`workspace_membership_last_owner_guard`, P0001, the same lock key; a
  workspace's own cascade delete passes). Keep the trigger function VOLATILE;
  under REPEATABLE READ / SERIALIZABLE it counts with `FOR UPDATE` (a race is
  40001), under READ COMMITTED with a plain count after the lock.
  Deleting the last OWNER's user account is refused until the workspace is
  dealt with.
- **The book bible (Phase 1.1).** A book's bible is `BibleElement`s of a
  CLOSED set of kinds (`BibleElementKind`, mirrored client-safe in
  `src/lib/bible/kinds.ts`; their order decides which template declares a
  relation). Each kind's fields and relation types are a JSON template in
  `src/lib/bible/templates/<kind>.json`, parsed with `templateSchema` when the
  registry loads (`getTemplate`, `getFieldDef`, `getRelationType`); labels
  are original, neutral craft words, never a published framework's
  (`tests/unit/bible/templates.test.ts` bans the names). A field is stored
  only when it has a value (`null`, blank or all-markup clears it), JSON-encoded
  by type, after `normaliseFieldValue` has checked it against the template
  (choice from the options, scale 1..5, list of strings) and sanitised it.
  An element's kind is fixed; a CUSTOM element carries a `customLabel` and no
  other kind may (CHECK). Slugs are unique per book; a derived slug is the
  first free candidate asked by the candidates themselves (`slugCandidates`,
  never a `startsWith` on the base, which misses a shortened stem), and a
  create that loses a race for it is retried with the next suffix, while a
  supplied slug that is taken is a 409. A relation is stored
  ONCE, from the element whose kind declares the type (or the built-in
  `related_to`), and read from both ends with the inverse label; cross-book
  and self relations are refused, and the composite `(bookId, elementId)` keys
  refuse them in the database too. A SYMMETRIC type (label = inverse label)
  is one fact from either end: the row carries `symmetric`, and the partial
  unique index `BibleRelation_symmetric_pair_key` over the unordered pair
  (migration only; Prisma cannot spell it, so never add a `@@unique` for it)
  refuses the reverse under concurrency, answered 409 RELATION_EXISTS. A
  read-then-write check in a usecase is the friendly answer, never the
  guarantee: what must hold under concurrency is a constraint, and the
  usecase maps its violation. **Every save of an element or its fields
  writes exactly one `BibleEntryVersion` in the same transaction**
  (`bible-common.ts`: `BibleElementRepository.lock` — a per-element advisory
  lock — then the change, then `recordVersion`); a save that changes nothing
  writes none. A restore applies an old snapshot as a NEW version. The
  version table is append-only by trigger (P0001 `BIBLE_VERSION_APPEND_ONLY`):
  only its book's cascade deletes a version, and only an author's deletion
  clears `authorId`; an element's own deletion leaves its history with the
  book. Permissions are `bible.view` (all), `bible.edit` (OWNER, EDITOR) and
  `books.delete` (OWNER: delete, list deleted, restore; Phase 1.H).
- **The bible UI (Phase 1.2).** A bible page is a server component that
  reads through the usecases (`getWorkspacePageCtx`, `orNotFound` for a 404)
  and hands plain data to one client component in `src/components/bible/`;
  what the viewer may do is `canEdit = ctx.permissions.bible.edit`, passed
  down, never a role read in the browser, and a reader gets values as text,
  not disabled controls. Templates reach the client through
  `src/lib/bible/ui-model.ts`, never by importing the registry into a client
  component. The client calls the 1.1 routes through
  `src/lib/bible/api-client.ts` (types only from the usecases), and words a
  refusal from its `details.reason` (`bible.errors`), never the server's
  message. Completeness is `completeness()`: no entries is "not started", a
  template with no fields "not assessed", and only a measured value draws a
  bar. Edits save through `useElementAutosave`: debounced, one request at a
  time, a failed batch requeued beneath newer edits; a save's answer never
  overwrites an input. Deleting an element or removing a relation goes
  through `useToastWithUndo`.
- **The vector store (subphase 2.0).** Every vector goes through
  `getVectorRepository()` (`src/app-layer/repositories/vector.repository.ts`);
  nothing else under `src/` loads a backend, names the `VectorEmbedding`
  table or reaches its delegate (`local/vector-store-single-seam`). Methods
  take the usecase's `runInWorkspaceContext` transaction and the workspace id,
  and the pgvector backend refuses any other transaction
  (`NOT_IN_WORKSPACE_CONTEXT`). A record is a key (`sourceModel`, `sourceId`,
  `chunkIndex`, `embeddingRevision`), a `bookId` (or `null`, stated), a
  `contentHash` from `vectorContentHash` (keyed HMAC, never a plain digest of
  author text) and the vector — any other member is refused
  (`UNKNOWN_RECORD_FIELD`); text stays encrypted in its source row and a
  search returns references and scores. The revision is the provider's
  (`embeddingRevisionOf`: model, dimensions, prefixes); two revisions are never
  compared. A source row's vectors are deleted with it: `deleteSource` in the
  same transaction, and the source table's migration attaches
  `vector_embedding_delete_with_source('<Model>')`; a book's and a workspace's
  vectors go by cascade. A rebuild of an empty source is refused unless
  `allowEmpty` (rule 6). Search is exact (no HNSW index until the production
  model is chosen; see `vector-search-params.ts`). The migration's `CREATE
  EXTENSION vector` needs a superuser: the image's `POSTGRES_USER` in the dev
  stack and CI, an operator once in production (the migration's header).
  Embeddings come from `getEmbeddingProvider()`: the stub unless
  `EMBEDDING_PROVIDER=tei`; production refuses the stub, and TEI's URL must
  resolve only inside the deployment (no external embedding route exists:
  adding one is an owner decision). Every Postgres the repository runs is
  `deploy/postgres/Dockerfile`; CI builds it, never pulls it
  (`tests/unit/postgres-image.test.ts`).
- **Bible import and export (Phase 1.3).** The Markdown bundle
  (`bundle-format.ts`, format version 1: `manifest.json`, `book.md`,
  `<kind>/_index.md`, `<kind>/<slug>.md`) carries its data in YAML
  frontmatter; the Markdown body is generated for reading and never imported.
  Rich text stays the stored HTML. Export is a function of the bible alone
  (no time, no id, fixed zip dates), so export → import into an empty book
  (with `?bookDetails=apply`) → export is byte-identical; keep it so. An
  import is bounded (`readBoundedBytes`, 20 MiB), virus-scanned (`scanBuffer`:
  INFECTED always refused, an unavailable scan refused in `strict`), unzipped
  by `readZip` (never another unzipper: it bounds count, sizes, ratio and
  names before inflating and stops a lying entry at its claim), parsed with
  aliases and tags refused, and validated and sanitised through the 1.1 paths;
  an unknown kind, field, option or relation type is refused by name. A bundle
  is ONE transaction: every problem is answered at once (`BUNDLE_REFUSED`,
  `problems: [{ path, reason, key? }]`) and nothing is written. Elements are
  matched by slug and saved through the versioned save with source `IMPORT`,
  so a repeat import writes nothing; the file is the element's whole state
  over the template keys its writer knew (the manifest's `templateFields`);
  nothing is deleted. Duplicate YAML keys are found by a set per mapping, never
  the library's quadratic `uniqueKeys`; the parse yields to the event loop
  after every file, and the bounds are 2 MiB a file and 24 MiB a bundle,
  inflated (Phase 1.H); `readZip` refuses a local header that disagrees with
  the central directory; `book.md` is read only when its details are applied.
  Export refuses (`EXPORT_TOO_LARGE`) a bundle `readZip`
  would refuse under the import's limits, so every export imports back. A
  concept note is a RESEARCH element's `notes` (an owner-approved field), and
  ALWAYS makes a new element: a derived slug that is taken goes to the next
  free one (`freeSlug`, `my-idea-2`), so the same note twice is two elements;
  a supplied slug that is taken is a 409 `SLUG_TAKEN`; only the bundle is
  idempotent per slug (#27 item 3). Uploads are never stored as
  files. A new refusal code goes in `IMPORT_REASONS` and
  `bible.transfer.reasons` (`tests/unit/bible/import-reasons.test.ts`).
  THE PDF FONT (#24) is Noto Sans 2.015 regular and bold (OFL, `fonts/noto-sans/`
  with `OFL.txt`, credited in NOTICE, sha256 pinned by
  `tests/unit/pdf/pdf-fonts.test.ts`), embedded as a subset; no standard font
  is loaded (`createPdfDocument` passes `font: ''` and registers `PDF_FONT`).
  Draw text only through `drawableText` (`src/lib/pdf/fonts.ts`): what the
  font covers (Latin, Latin Extended, Greek, Cyrillic) is drawn as itself;
  each other user-perceived character (CJK, emoji) is one `�`, never a box or
  nothing. The files are read from `<cwd>/fonts/noto-sans`, which the image's
  runner stage COPYs into `/app`; `pdfkit` and `fontkit` are server external
  packages. `breakLongRuns` cuts long runs between grapheme clusters.
  `tests/helpers/pdf-text.ts` reads text back through each font's ToUnicode
  map.
- **Model calls (Phase 2.1).** A feature calls a model only through
  `callStructured(ctx, { template, data, schema, bookId, signal })`
  (`src/app-layer/usecases/model-calls.ts`), from its own usecase after its own
  permission check, with a template from `definePrompt` (static `system` and
  `task`, a version, a tier — `fast` / `balanced` / `deep`, never a model id).
  Author text goes ONLY in `data` blocks, which `fenceData` wraps in
  nonce-tagged fences after neutralising any spelling of the tag; never put
  author text in a template, a system prompt or an output schema (the API
  caches schemas outside zero retention). Every exit records one `AiCallLog`
  row (numbers and names, never text; append-only) and settles its cost; the
  workspace's monthly ceiling (`AI_MONTHLY_CEILING_USD_DEFAULT`, $50, D10) is
  checked against the call's worst case BEFORE it is sent, under a
  per-workspace advisory lock plus a reservation row; `AI_DISABLED=1` refuses
  everything. Only `src/lib/ai/client.ts` loads the SDK or names the
  provider's host (`model-provider-host-single-seam`), and its middleware
  sends Messages calls only, by allowlist: body members
  (`PERMITTED_BODY_MEMBERS`), `output_config` members and content block types
  (`PERMITTED_CONTENT_BLOCK_TYPES`: no `url` or `file` sources) are each a
  reviewed line; a new server tool type is added to
  `PERMITTED_SERVER_TOOL_TYPES` and nowhere else (since 2.6 exactly `web_search_20260209` and `web_fetch_20260209`, each with `allowed_callers: ["direct"]`, its own name and `max_uses` 1..50, and their blocks only in assistant turns). An output
  schema the structured-output feature cannot take (a record, recursion, a
  non-object root, past the optional / union limits) is refused when the
  request is built. Calling a model is NOT a permission of its own: it runs
  under the calling feature's key, checked by its usecase first (`bible.edit`
  for an interview; issue #30, item 1). Production REQUIRES
  `ANTHROPIC_API_KEY` unless `AI_DISABLED=1`, and a key requires a declared
  retention mode, `AI_RETENTION_MODE` (D5, amended 2026-11-19): `zdr` (an
  organization arrangement with Anthropic, not a request option; 2.1's
  `ANTHROPIC_ZDR_CONFIRMED=1` still reads as it) or `standard-beta` (standard
  retention, the closed beta only: `[startup] WARN` at every start of the web
  tier and the worker, `aiConfigWarnings`); never a default, and `zdr` is the
  Phase 7 launch gate. `aiUnavailableReason` (`src/lib/ai/config.ts`) is the
  one reading of "no call can be made" (kill switch, no key, ambient headers,
  no mode in production): `clientForRun` refuses by it and a feature asks it
  BEFORE writing (`modelUnavailableReason`, 503 `AI_UNAVAILABLE` naming the
  reason). A template may carry its per-call cost budget
  (`costBudgetMicroUsd`, rule 9; logged `overBudget`, not a gate in 2.1 — a
  feature may enforce it before the call, as bible fact extraction does). A failed
  call's tokens and cost are on its error (`AiCallError.tokensUsed`,
  `.costMicroUsd`), a successful one's on the
  result (`tokensUsed`, `costMicroUsd`). Tests hand the SDK
  `tests/helpers/fake-anthropic.ts` as its fetch (scripted, `respond` and
  `repeat` turns); no test reaches a provider.
- **Hardening the bible (Phase 1.H).** CONCURRENT EDITS: every element
  change, fields save and restore MUST name `baseVersion` (an omitted one is a
  400, so no request skips the check); under the element's
  lock a newer version refuses it 409 `VERSION_CONFLICT` with
  `currentVersion`, writing nothing (`assertBaseVersion`). The imports save
  over whatever stands (a file is its element's whole state), but compare
  with the element read UNDER its lock, never the row looked up before it. The UI
  (`useElementAutosave`) holds a refused batch and sends nothing more
  until the author reloads or keeps their edits; never retry a save over a
  newer version unasked, and re-base after a restore or reload
  (`setBaseVersion`). Held edits are never sent on the way out: an in-app link
  asks first, and any other navigation keeps them in memory for the tab until
  the element's page is opened again. DELETING A BOOK is soft and `books.delete` (OWNER):
  `deletedAt` hides it from every list and route (`BookRepository.find` and
  `BibleElementRepository.find` read live books only; a usecase reaches a
  book's rows through `requireBook`/`requireElement`), the OWNER restores it
  for `BOOK_RESTORE_DAYS` (30), and only the daily `book-purge` job deletes
  it — the trigger `book_delete_only_when_purge_due` refuses any earlier
  delete for every role except the workspace's cascade (comparing `deletedAt`,
  UTC without a zone, with `now() AT TIME ZONE 'UTC'`, never the session's
  zone). LISTS are bounded and
  honest: every `findMany` has a `take` (`find-many-bounded` guard); a capped
  read asks one more and says it was cut (`truncated`, `relationsTruncated`,
  `nextCursor`); the board reads counts and filled fields by aggregate and the
  first 25 entries a kind in one query (the filled fields per element through
  a `LATERAL … OFFSET 0` index probe: as a plain join, a book the planner's
  statistics did not know yet got a quadratic nested loop); the element list is a keyset page by
  name (`listElements`: `kind`/`kinds`, `q`, `after`), which the relation
  picker searches; list rows carry no encrypted column. Every model a list
  query reads has its index curated in `schema-index-coverage` (workspace-led
  indexes, indexed foreign keys). A page's reads live in `bible-pages.ts`, and
  the load test (`bible-load.test.ts`) holds them to 300 ms at p95.
  EXPORT downloads go through `bibleDownload` (a refusal is shown, never saved).
- **The question engine (Phase 2.2).** An interview asks, each round, the
  whole FRONTIER (`computeFrontier`): every open field whose `dependsOn` is
  satisfied, within the depth dial, after the already-answered checks remove
  what the book holds — the bible's stored values always first (rule 5), then
  any pluggable `AlreadyAnsweredCheck` (a concept seed, a 4.1 fact). An
  ANSWERED answer of THIS session satisfies its fields; SKIPPED / DECIDE_LATER
  touch them (not asked again, dependants wait); earlier sessions' answers do
  not count. Core fields lead the frontier, optional ones follow. The model
  only WORDS questions, behind `QuestionGenerator`; code validates every
  candidate (`validateCandidate`: targets, kind by detail, options, text,
  challenge quote; a bad recommendation is stripped, never fatal),
  deduplicates (`dedupe`: lexical signals, a keyed `dedupeKey`, and the 2.0
  vector store's neighbours, and the book's index asked for the round's own
  candidates; a question about another element is never a repeat), asks each
  field once a round (so a round never passes its cap), fills gaps from the
  craft pack's examples, orders and numbers.
  `produceRound` is that whole step, run by the usecase AND the coverage
  evaluation. The model call is OUTSIDE every transaction: claim the round
  (GENERATING, under the session's advisory lock), generate, persist — and
  persist re-reads the book, dropping a question whose field was filled or
  whose element was deleted meanwhile (rule 5). A call returns
  `{ output, tokensUsed }`, and the tokens are charged to the session's
  budget whatever becomes of the round. Every
  stop records a reason (`InterviewStopReason`; FRONTIER_EMPTY vs
  NOTHING_AT_DEPTH vs ROUND_BUDGET, and `stopDetail` in ids, keys and 2.1
  error codes), in ONE precedence (`decideStop`, `src/lib/interview/stop.ts`:
  the frontier first — a session with nothing left to ask FINISHES even with
  the kill switch on — then the kill switch and the ceiling, which pause only
  a session that would need the model, then the token and round budgets); a
  session that asked nothing is NOT_ASSESSED, and a scope with no element is
  refused (`SCOPE_EMPTY`). THE MODEL STEP is wired in
  `src/lib/interview/model-seam.ts` and nowhere else:
  `defaultQuestionGenerator(ctx)` calls 2.1's `callStructured(ctx, …)` with
  the request `buildGenerationRequest` makes — a `definePrompt` template
  (`QUESTION_PROMPT`: version, tier `balanced`, output and cost budgets; its
  system prompt the engine's instructions plus the round's product guidance,
  dials and packs, never author text) and the author text as labelled data
  blocks (`element.N`, `targets.N`, …; 2.1 fences and guard-scans them) — and
  returns the call's real `tokensUsed`. Each 2.1 outcome maps to a named
  call failure (GUARD, TIMEOUT, ABORTED, PROVIDER, INVALID_OUTPUT: that
  persona's fields go to the pack fallback; a round left empty pauses
  GUARD_REFUSED / PROVIDER_FAILURE / NO_ACCEPTABLE_QUESTION) or a
  `GenerationStop` (KILLED → KILL_SWITCH, CEILING → WORKSPACE_CEILING: the
  round is abandoned, its tokens charged, the session paused); the table is
  the seam's header. A request that would generate first asks
  `unavailableReason()` and refuses 503 `AI_UNAVAILABLE` naming 2.1's reason
  (no key: CREDENTIAL_NOT_CONFIGURED) before writing; `modelBudgetSignals`
  reads the kill switch and the month's spend before a claim. Nothing fakes
  model output, and nothing answers 500 for a model condition. The output
  schema (`GeneratedQuestionsSchema`) is code within 2.1's structured-output
  limits (`tests/unit/interview/model-seam.test.ts`). `bible.edit` runs an
  interview, `bible.view` reads one. Answers are append-only (a re-answer is
  the next revision, while the round is open, at most `ANSWER_REVISIONS_MAX`;
  a session's bounded reads must hold every question and revision it can
  have, `session-bounds.test.ts`). Question and answer text are
  in the encrypted manifest; a question passes `sanitiseQuestionForStorage`
  before it is judged and again as it is written. `Question` is the vector
  store's first source table: its vectors go with it, and
  `vector_embedding_require_source` refuses (or, in a rebuild, skips) a vector
  whose question is gone or being deleted, taking its lock SKIP LOCKED so a
  vector write never waits on (and so never deadlocks with) a delete (issue
  #23 item 1). Packs (`src/lib/interview/packs/`, original content) are
  validated with Zod at load and read from disk at `process.cwd()` (the
  Dockerfile copies the directory); a production server loads them at boot
  and exits 1 when they do not.
- **Dials and packs (Phase 2.3; D11).** A session's dials are resolved ONCE,
  at start, per dial: its request, then `BookInterviewDefaults`, then
  `WorkspaceInterviewDefaults`, then `CODE_DEFAULT_DIALS` (`resolveDials`; a
  NULL column passes the dial on; `personaKeys: []` is a setting). Defaults are
  read under `bible.view` and replaced whole (PUT) under `bible.edit`. A DIAL
  CHANGES PROMPTS AND BUDGETS ONLY (`dialEffects` is the list): no module on
  the bible's write path (anything importing `writeFieldValues` /
  `recordVersion`) may import a dial or pack module, even for types
  (`tests/guards/dials-stay-off-the-bible-write-path.test.ts`). Up to three
  personas (CHECK, distinct): each words its round-robin share in its own
  call with its own pack, its questions tagged (`personaKey`, `personaName`);
  before a round is claimed the month must take one least-cost call per
  persona (`modelBudgetSignals(…, calls)`), never a round it cannot finish;
  every call's prompt version is `question-generation.<v>+packs.<12 hex>` over
  its packs' hashes, and `metrics.calls` names them. A pack MOUNTS only when
  every file of it (PACK.md, evals.json, a persona's situations.json) passes
  the load-time scan (`pack-text-scan.ts`) and its
  `evaluation-record.json` passes when REPLAYED through `produceRound` and
  graded against its `evals.json` (`pack-evaluation.ts`; tied to the pack's
  content hash, the set's hash and `QUESTION_PROMPT_VERSION`; its `generator`
  claim is checked, not believed: a structural record must be exactly what the
  structural generator reproduces, and a model record holding the structural
  generator's output is refused `STRUCTURAL_OUTPUT_AS_MODEL`); PRODUCTION
  accepts only a real model's record, development and test a structural one
  too, with no override (D11, `pack-records-config.ts`) but one: the
  loopback-only model stub (D13, `loopbackStubMode`), asked in
  `packRecordModeOf` and nowhere else; the start-up check refuses a
  structural mode beside a real host. A refused pack is 503
  `PACKS_NOT_MOUNTABLE` naming each pack, nothing written, and production
  logs `[startup] WARN` with the counts. A session pins its packs at start
  (`packPins`, write-once by trigger) — each kind's craft pack (every kind for
  a BOOK session) and each persona's — and every round compares them first
  (`pinMismatch`): a changed or unpinned pack pauses it `PACK_CHANGED` (a
  2.2 session, NULL pins, is never pinned later and stays paused). After
  editing a pack, its `evals.json`, `situations.json` or the question prompt,
  re-run `npm run packs:evaluate`; real-model records come from the Evals
  workflow and land by a reviewed pull request (the 2.3 note, "Evals").
- **The interview experience (Phase 2.4).** Starting an interview and each
  next round STREAM (`…/interviews/stream`, `…/:sessionId/rounds/stream`,
  `interviewStreamResponse`): a refusal before the work is under way is the
  ordinary JSON error; after it, events (`src/lib/interview/stream-events.ts`)
  end with `committed` or `refusal` (a code) and then `done`. The round is
  still persisted in ONE transaction after generation: `draft` events are
  validated candidates, shown read-only, and only the `committed` round's
  questions are answerable. Closing the stream aborts the signal the usecase
  hands the model call; the round is abandoned (FAILED, tokens charged, no
  question written) and the session stays resumable. `produceRound`'s
  observer is told, never asked (a throw is swallowed). "Ask me this
  differently" is its own prompt (`REPHRASE_PROMPT`, fast tier); the old
  wording travels as a data block; the rephrase replaces the question
  (`replacesQuestionId`, the original `supersededAt`, one transaction), only
  one of the pair is answerable (409 QUESTION_SUPERSEDED), and a round holds at
  most `REPHRASES_PER_ROUND_MAX` (counted again under the lock before the
  write). A rephrase is held to a round's rules: never a field the bible now
  answers (409 ANSWERED_IN_BIBLE), only the session's pinned, mountable packs
  (`pinMismatch`), its version naming them (`packsVersionOf`). Never change `QUESTION_PROMPT`'s text or
  version for UI work (2.3's evaluation records pin it). The setup sheet reads
  and sends the dials ONLY through `src/lib/interview/setup.ts`. A card saves
  each answer as it is given (a pick at once; text on save, Ctrl/⌘+Enter, or
  leaving the box), one request at a time, keeping the answer on failure;
  finishing a round and stopping first `flush()` every card and wait for its
  saves (a close or a stop never overtakes an answer), and a failed save holds
  them;
  digits are bound `within` the card. Stop reasons and refusals are worded from
  their codes (`src/components/interview/messages.ts`; the stop table is keyed
  on `StopReason`, so a new reason fails `tsc` until worded); client code never
  spells a server variable's name. `AI_MODEL_STUB=1` (`src/lib/ai/model-stub.ts`)
  is `clientForRun`'s fetch seam taken by configuration, for a local test
  server: production refuses it unless `APP_URL` and `NEXTAUTH_URL` are both
  loopback, and anywhere beside `ANTHROPIC_API_KEY` (D13; a WARN at every
  start). In that mode only, structural pack records mount too. The interview E2E runs
  against the second E2E server (`test.use({ baseURL: STUB_BASE_URL })`).
- **Enrichment (Phase 2.5; rules 1 and 2).** When a round CLOSES (the close
  and stop routes call `closeRoundAndReconcile` / `stopInterviewAndReconcile`)
  its reconcile run makes ONE model call (`RECONCILE_PROMPT`, balanced tier,
  version and cost budget on the template) under 2.2's claim pattern: claim
  the `ReconcileRun` under the session lock, call outside every transaction,
  persist under the lock again. Every 2.1 outcome is a named run outcome
  (`RECONCILE_OUTCOMES`, the table in `src/lib/enrichment/model-seam.ts`); a
  failed or refused run proposes nothing and is re-runnable (POST
  `…/rounds/:n/reconcile`), and never undoes the close. Code validates every
  proposal (`validate.ts`, the order in its header): in the round's scope, the
  op fits the stored value (ADD empty, UPDATE / REMOVE filled), cites only
  this run's ANSWERED answers, a value `normaliseFieldValue` accepts, no copied
  instruction (markup or a script scheme, an unvouched URL, the guard's
  injection hit, an answer cited by id in the text), and every sentence grounded
  in the cited answers (`groundSentence`, 70 %; for UPDATE also the stored
  value). Refused, never softened; NO_CHANGE and refusals are counts on the
  run, never rows. A sentence that addresses the product
  (`addressesTheProduct`) is NOT refused (D14): the proposal is stored with
  `flags` `POSSIBLE_INSTRUCTION`, shown as a possible instruction, never
  bulk-accepted, accepted one by one. A RUNNING run older than
  `STALE_RECONCILE_MS` reads FAILED `CLAIM_EXPIRED` (`effectiveRunState`) and
  is re-runnable. The database holds the rest: a citation's foreign key is
  `(workspaceId, sessionId, answerId)`, a trigger refuses a non-ANSWERED
  answer, a deferred trigger a proposal with no citation, and
  `enrichment_proposal_fixed` every change but the one decision. ONLY
  `enrichment-review.ts` writes the bible from a proposal: through the
  versioned save under the element's lock, `baseVersion` required (409
  VERSION_CONFLICT), an element moved since the proposal needs
  `reviewedCurrent` (409 PROPOSAL_OUTDATED), the op must still fit (409
  PROPOSAL_STALE), and the version is source INTERVIEW with
  `sourceAnswerIds` (CHECK `BibleEntryVersion_interview_names_answers`; a new
  element through `createElementInTx`, refused when the book holds the name by
  `nameKey`: `bookHoldsElementName`); bulk accept is unflagged ADD into fields
  still empty, all or nothing. That module is on the write path: no dial, pack or
  model import. D11 applies to reconcile (`record-gate.ts`, the packs' own
  `deploymentPackRecordMode()`, so D13's stub server accepts structural
  records too): production reconciles only on a real model's
  `evaluation-record.json`; otherwise the run is REFUSED
  `RECONCILE_NOT_EVALUATED` and the answers wait. After editing the sets, the
  prompt or the output schema, re-run `npm run packs:evaluate -- --no-packs
  --reconcile`. The review page words refusals from `enrichment.errors`; a
  reader reads, an editor decides.
- **Research (Phase 2.6; D9).** A brief (question, purpose, scope elements,
  at most `SOURCES_PER_BRIEF_MAX` URLs and text/Markdown files through the 1.3
  bounded, virus-scanned path, a depth) is run by the `research-run` job, one
  per run (`attempts: 1`, payload ids only), under `bible.edit`; `bible.view`
  reads. A run is three model steps: GATHER (the server web tools, through
  `runServerToolLoop`), FINDINGS and FIT (`callStructured`). QUERY EGRESS
  (`src/lib/research/query-egress.ts`, the header is the contract): the brief
  is refused when it quotes the book's stored text (`BRIEF_QUOTES_BIBLE`, a
  4-word shingle with 2 content words, against the book's title, logline,
  element names, labels, summaries, field values and relation notes), the
  gather request carries the brief and NOTHING ELSE of the book, and each
  query and fetch URL (its host too) is checked as the stream completes it — a
  TRIPWIRE (the provider runs a server tool before we see it), never described
  as a gate. Never add bible, manuscript or answer text to the gather request.
  Every query and URL a run sent is stored as the stream delivers it
  (`ResearchEgress`, encrypted, at most 100 a run, refused ones marked) and
  listed on the run's result page as plain text (D15). Fetched pages and files are untrusted data
  (fenced, guard-scanned) and never stored whole: a finding stores only a
  quoted span `quoteFound` verified in the text the findings call was shown
  (search results are encrypted by the provider, so only FETCHED pages can be
  cited). FIT proposals (ADD, UPDATE, NEW_ELEMENT) stay inside the scope and
  the templates, cite this run's findings, never write prose (D3), and are
  flagged, not refused, when they address the product (D14). Depth caps
  searches, fetches, requests and spend (`DEPTH_BUDGETS`); every request is an
  `AiCallLog` row under the ceiling and the kill switch. Accepting writes one
  version with source RESEARCH naming its proposal and findings (CHECK
  `BibleEntryVersion_research_names_findings`); a run that found nothing
  says why (rule 6). D11 applies (`research/record-gate.ts`). After editing
  the sets, prompts or schemas, re-run `npm run packs:evaluate -- --no-packs
  --research`. `docs/sub-processors.md` is the sub-processor draft.
- **Hardening Phase 2: security and privacy (2.H).** INJECTION: every case
  of `src/lib/redteam/injection-corpus.json` runs through the product's own
  steps (`injection-suite.ts`) and is judged on what is shown or stored
  (SCOPE, DISCLOSURE, CROSS_BOOK, INSTRUCTION, TOOLS): against a COMPROMISED
  fake model in the unit suite (every property must hold whatever the model
  says), against the real usecases with two books in the integration suite,
  and against the real model nightly. A new surface that sends author text to
  a model joins the corpus. DISCLOSURE is refused by code: a validator asks
  `disclosesInstructions` (eight consecutive words of its own prompt's static
  system or task text, or the fence's tag; the graders still count six) of everything it shows or stores. VALIDATORS
  also keep their source's polarity (`polarityKept`), refuse a bare domain no
  source gives (`addressesIn`), and a REMOVE must cite an answer to a question
  about that field (`REMOVE_NOT_ADDRESSED`). PRIVACY:
  `tests/integration/privacy-sinks.test.ts` plants a marker in every
  author-text path and reads every sink (logs, spans, Sentry, `AiCallLog`,
  audit details); a new path or sink joins it. Sentry gets no query string or
  fragment (`redactUrl`). ZERO RETENTION: under `AI_RETENTION_MODE=zdr` a tier
  override must be `ZDR_ELIGIBLE` (no Fable, no unknown model); the settings
  as configured are listed in `docs/sub-processors.md`. MODEL CALLS: a failed
  call's guard flag rides on its error (`reviewRequired`, `guardRuleIds`); a
  record is settled by `settleRecord` (again, then `safeCallRecord`); a repair
  turn states fixed sentences per issue code, never Zod's message, and never
  edits a turn that carries thinking. Money columns are BIGINT. RESEARCH: a
  non-text fetch (a PDF) stops the gather request (`NON_TEXT_FETCH`) and each
  request reserves one context window for it; a page citation stores the
  page text's SHA-256 (`sourceSha256`, `citationProvable`). NAMES: every
  create, rename and `bookHoldsElementName` check takes
  `BibleElementRepository.lockNames` (before any element lock). DELETION
  TIME: for app_user a set `deletedAt` is the database's clock (trigger
  `book_deleted_at_is_now`); tests backdate as the superuser. RETENTION:
  `AiCallLog` rows past `AI_CALL_LOG_RETENTION_DAYS` (default 400, floor 365
  in the trigger) are deleted by the daily `ai-call-log-retention` job outside
  row-level security; app_user still deletes nothing. Keyed hashes per
  workspace come from `workspaceSubkey` (the vector content hash uses it;
  `dedupeKey` does not yet: the 2.H note has the rekey design).
- **Hardening Phase 2 (2.H: robustness, cost, evaluation records).** BUDGETS:
  every model feature stops at its session's or run's budget and at the month
  before it sends anything — a round (TOKEN_BUDGET, and it opens only if the
  budget also takes its reconcile: `nextRoundTokens`), a rephrase (409),
  reconcile (REFUSED `TOKEN_BUDGET`), research (BUDGET_SPENT), each the ceiling
  too; and every request that will call a model charges
  `chargeModelCalls(workspaceId, calls)` first (`MODEL_CALLS_LIMIT`, 100 a
  minute per workspace, D17; in-process, off where the rate tiers are off). The
  ledger judges expiry by the database's clock (`dbNow`) and RELEASES an
  expired, unsettled reservation, charging nothing (`releaseExpired`, D17),
  logged `ai.reservation_released` (ids and amounts) and counted
  (`ai.reservations.released`, `…_micro_usd`); a stream cut off mid-way, the
  research gather's PDF stop included, is charged its unseen output at
  `max_tokens`, `costEstimated`. STREAMS: every SSE route takes
  `takeStreamSlot(ctx.workspaceId)` (429 `STREAM_CAPACITY`) and releases it
  once, after the run settles; a new stream route does the same. FAILURES end
  resumable with a worded code (`tests/integration/model-feature-hardening.test.ts`
  holds each feature to it). LATENCY is held by counted work, never a wall
  clock (`interview-latency.test.ts`: the first question after one call).
  REPETITION: `bookRepetition` over a book's questions must find none; the
  `interview.questions.repeats_dropped` counter shows the pressure; since 4.4
  it is a hard gate at persist (`withoutRepeats` under `lockBookQuestions`). RECORDS:
  every exported `definePrompt` template is evaluated by a record that pins its
  `promptContentHash` (and every pack record its pack's and set's hashes);
  `tests/guards/evaluation-records-current.test.ts` recomputes them, so after
  editing a prompt, a pack or a set re-run `npm run packs:evaluate` with the
  flag that covers it. A new product prompt needs a set and a record (the
  rephrase prompt's is the smallest example), and a production gate on a
  real-model record unless the owner decides otherwise: reconcile and research
  have one; "Ask me this differently" runs in production without one (D17: it
  only rewords a question), its record and hash pin held in CI. The judge
  (`src/lib/evals/judge.ts`) grades the ungraded behaviours in the Evals
  workflow only; no product module imports it, and its pass bar is unset.
  Verdict caches that two module graphs (instrumentation and routes) both read
  live in `processSharedMap`, keyed by content hashes, never by object
  identity. Vector writes refuse any isolation but READ COMMITTED
  (`UNSUPPORTED_ISOLATION`). A re-imported field whose template type changed
  is coerced only where nothing is lost (`field-coercion.ts`), else refused
  `FIELD_TYPE_CHANGED`. Cosine thresholds for deduplication are per embedding
  revision (`DEDUPE_COSINE_THRESHOLDS`, `dedupe-thresholds.ts`; uncalibrated
  until the production model is chosen). CI reads Docker Hub through
  `mirror.gcr.io`.
- **The story canvas (Phase 3.1; D1, D18).** ROWS ARE THE SOURCE OF TRUTH;
  tldraw is a view. A book has at most one map of each kind (unique
  `(bookId, kind)`), created on its FIRST SAVE: an unsaved map reads as empty at
  version 0 and a read never writes. A node draws one BibleElement and an edge
  one BibleRelation, each at most once per map, so their ids are the canvas's
  keys; the book is in every foreign key, and `saveStoryMap` refuses an
  element or relation of another book (`UNKNOWN_ELEMENT` / `UNKNOWN_RELATION`),
  an edge that is not its relation's own pair (`RELATION_MISMATCH`) or not
  between two nodes. `tldrawToRows(rowsToTldraw(rows))` is the identity
  (`serializer.ts`); what a node SHOWS (name, kind, completeness) is the
  bible's, passed beside the rows (`MapDisplay`) and never saved, and
  `canvas-changes-tldraw.ts` compares persisted props only. THE VERSION LOCK:
  every save and restore names `expectedVersion`; under the advisory lock on
  (book, kind) a different version is 409 `VERSION_CONFLICT` with
  `currentVersion`, writing nothing; a save equal to the stored state writes
  nothing; every other save writes one `MapSnapshot` (append-only by trigger,
  P0001 `MAP_SNAPSHOT_APPEND_ONLY`). The client stops on a 409 and offers
  Reload or an explicit save-over, never a retry. Deleting an element or
  relation cascades to its nodes and edges and bumps the map's version ONCE
  (trigger), so an open tab is refused, and writes that version's snapshot
  (D20: every version has one; a deferred trigger refuses a version without
  one at commit): a usecase that deletes from the bible calls
  `lockMapsForBibleDeletion` BEFORE the delete and
  `recordMapsAfterBibleDeletion` after it. A restore is a NEW save and drops
  (and counts) what the bible no longer holds. The freeform layer (sticky notes) is
  author text: encrypted, bounded, prototype keys and the canvas's own record
  types refused, strings sanitised (`sanitiseFreeformForStorage`). An arrow
  between two nodes becomes an edge only along a relation the book holds.
  tldraw loads ONLY through `next/dynamic` with `ssr: false` behind
  `CanvasErrorBoundary` (`StoryMapEditor`); `scripts/check-build.js` fails a
  build that puts it in any route's first load. Its fonts, icons and
  translation come from `/api/canvas-assets/<version>/…` (`@tldraw/assets`,
  an allowlist), never its CDN, which the CSP refuses; the tldraw user is
  created once (a user rebuilt per render reloads its translation forever).
  tldraw stays on major 3 with the watermark on and no licence key
  (`tests/guards/tldraw-major-version.test.ts`,
  `tldraw-licence-and-watermark.test.ts`); auto-layout is dagre only (D18).
  THE TIPTAP OVERRIDE (D20): `package.json` overrides tldraw's and
  `@tldraw/editor`'s TipTap dependencies onto the root's 3.x line, because
  GHSA-cp6q-959q-f8rh has no TipTap 2 fix and tldraw 3.x declares TipTap 2. It
  and the tldraw major-version guard move together: a tldraw bump re-reads the
  override, and `tests/guards/tldraw-tiptap-override.test.ts` fails on a
  TipTap package off major 3, a TipTap dependency of tldraw's left
  un-overridden, or a tldraw that no longer declares TipTap 2 (then the
  override goes). Under it the canvas runs tldraw's rich text on
  `STORY_TEXT_OPTIONS` (TipTap 3's StarterKit cut back to TipTap 2's set, so
  tldraw's own Link is the only one). The sticky-note E2E
  (`tests/e2e/story-map.spec.ts`) is its proof in a browser. `bible.view` reads
  a map, `bible.edit` saves and restores. jsdom tests mount tldraw through
  `tests/helpers/tldraw-jsdom.ts` (its `fetch` is a local stub).
- **The three maps (Phase 3.2; D22).** Each map draws its own kinds
  (`MAP_ELEMENT_KINDS`: relationship CHARACTER/FACTION, plot board PLOT_BEAT,
  timeline TIMELINE_EVENT); `saveStoryMap` refuses another 400
  `KIND_NOT_ON_MAP`. The plot board and the timeline are DERIVED
  (`mapLayoutMode`): a card's lane and place come from the bible — a beat's
  `act` field and its rank, an event's rank — through `deriveLaneLayout`
  (`src/lib/canvas/lanes.ts`), which the server applies to every save, restore
  and view and the canvas to every relayout; never store a position the
  author dragged there. A drop is an ORDER MOVE (`moveElementInOrder`, POST
  `…/elements/:id/order`, `bible.edit`): the order's advisory lock
  (`lockOrder`, BEFORE any element lock, and the bundle import takes it the
  same way) then the element's, `baseVersion` checked, one rank written
  strictly between the neighbours (`placeRank`), one version marked
  `movedInOrder` (never a product sentence in `changeSummary`). Ranks are
  compared in code (`compareRanks`), never by a collation; the unique
  `(bookId, kind, orderRank)` is the guarantee; NULL is "not placed yet"
  (creation places nothing). A restore keeps the element's place. The canvas
  puts cards back with `placeCards` / `showNodes` (`mergeRemoteChanges`: no
  edit, no undo step), and on a derived map a node's move is not a map edit
  (`derivedPositions`). Timeline lanes come from `takes_part_in` relations,
  never the free-text `participants` list. An arrow with no relation to draw
  opens `RelationTypePicker` (the kinds' templates plus `related_to`, stored
  from the declaring end); deleting an edge removes its RELATION through
  `useToastWithUndo`, after saving the map without it. A node opens in
  `ElementSheet` (the element page's `FieldEditor` and `useElementAutosave`).
  The embedded views on element pages are `StoryMapPreview`, an SVG with no
  tldraw. The bundle carries a rank as `order:` (refused `ORDER_NOT_ALLOWED`,
  `ORDER_INVALID`, `ORDER_DUPLICATE`, `ORDER_TAKEN`); the PDF prints ordered
  kinds in story order.
- **Interview from the canvas (Phase 3.3; D24).** A relation type declares
  1..4 PROSE fields beside its type in its template (`related_to`: nature,
  significance); they are rows (`BibleRelationField`, encrypted, sanitised
  through `normaliseFieldValue`), found by word search from both ends and
  carried by the bundle, and every change to a relation's fields, and every
  relation the product creates, writes one `BibleRelationVersion` (append-only,
  its own advisory lock, `baseVersion` 0 = a relation with no version yet; 409
  VERSION_CONFLICT) — never a version of either end. A question is about a
  SUBJECT (`subjectIdOf`): an element, a relation (filed under its declaring end
  with `relationId`) or the beat not yet created (`PENDING_SUBJECT_ID`, filed
  under the slot's earlier neighbour with `aboutPending`); each relation field is
  a frontier entry, and a field the relation holds is never asked (rule 5). A
  SELECTION session is the selected elements, the selected relations and every
  relation between two selected elements, frozen at start (SCOPE_EMPTY,
  SCOPE_TOO_LARGE, another book's id a 404); BETWEEN is two adjacent placed beats
  of one act (SLOT_INVALID naming the problem). Reconcile's NEW_RELATION and the
  slot's NEW_ELEMENT are refused, never softened, by the rules in
  `validate.ts`'s header; a link to a new element waits for it (409
  END_NOT_CREATED / END_GONE); the slot's beat is created in its act and placed
  by the order move under the order's lock, both versions naming the answers.
  Ghosts are drawn in `OnTheCanvas` from React state, NEVER store records, behind
  their own error boundary; the list beside the map (`PendingStructureList`, no
  tldraw, outside the canvas boundary) is the record, and what is accepted there
  is added to that map through its own save. The relations pack and the reconcile
  prompt follow D11; after editing either, re-run their records.
- **Hardening the canvas (Phase 3.H).** THE ROUND TRIP is a property:
  seeded random graphs (`tests/helpers/random-graph.ts`, mulberry32, no
  dependency) through rows → tldraw → rows, the canonical state and each
  derived layout, in pure code and through a live store. AT THE BOUNDS (500
  nodes, 1,500 edges) work is counted, never timed: the serializer's duplicate
  check is linear, an edge's binding is found by its id
  (`bindingIdForRelation`, which `drawRelationEdge` now gives every binding),
  never by a scan of the store, and a save or view sends the same number of
  statements at 500 nodes as at 50 (`canvas-hardening.test.ts`). ARRANGE runs
  dagre in a Web Worker (`layoutOffMainThread`; the main thread only when no
  worker can run): the worker is a chunk of its own, made per job and
  terminated, carries ids and numbers only, and loads no other script — its
  response has the static assets' `default-src 'none'`, so `next.config.mjs`
  keeps its chunk (`story-map-layout`) out of Next's splitting and
  `check-build.js` refuses an `importScripts` in it or the worker in any first
  load. THE BUNDLE BUDGET: every route's first-load JS and CSS, gzipped, is
  held to `scripts/bundle-budget.json` (recorded size + `BUDGET_HEADROOM`, 10 %);
  a route over it, without one, or a budget for a gone route fails Build. To
  raise one deliberately: build, `node scripts/check-build.js --no-build
  --record-budget`, commit the file and say in the pull request what grew and
  why; never widen the headroom. THE LIST VIEW (`StoryMapListView`, the map
  page's Canvas / List toggle) is every canvas action as named buttons —
  open, remove from map, earlier / later, relate (two choices, then the type
  picker), question or remove a relation, grill a selection — acting through
  the same editor and handlers, so it saves through the same autosave and
  version lock; a new canvas action gets its list equivalent and joins the
  keyboard E2E (`tests/e2e/canvas-hardening.spec.ts`). HISTORY is read a page
  at a time (`SNAPSHOT_PAGE_SIZE`, `?before=<version>`, `nextBefore`), so every
  version stays reachable; a restore with unsaved canvas edits says so and
  saves them first (`beforeRestore`). A snapshot must name the map's CURRENT
  version (trigger `map_snapshot_names_current_version`, every role: write the
  version, then its snapshot); a bible deletion's once-per-transaction marker
  is ONE setting (`inkquisitor.map_cascade`), never one named per map. Stored
  rich text is proved renderable before it is restored (`restoreFreeform`);
  one that is not keeps its words as plain text. `sanitizePlainText` keeps a
  `<` that never closes (`if a<b then c` stays whole) and parses before it
  decodes; what a browser would read as markup is still stripped, and the
  result is idempotent (an exported value imports back as itself). The D1
  guard also refuses the watermark reached without its class name (its
  `SEE-LICENSE` suffix, its `data-debug` / `data-mobile` attributes, a class
  substring selector, a link to tldraw, the word in a stylesheet).
- **Word search (Phase 3.4; D21).** OPTION A, DECRYPT AND SCAN: `searchBook`
  reads one book through `runInWorkspaceContext` (the encryption extension
  decrypts it), turns every source into plain text, and ranks it in memory
  after the transaction commits; it STORES NOTHING — no token table, tsvector,
  blind index or cache that outlives the request (option B, a blind index, is
  deferred). Searched: an element's name, custom label, summary, every stored
  field (rich text through `HtmlTextReader`, never a tag-stripping pattern,
  with a break between blocks, and a phrase never matches across one; a
  list's items; a choice's label; not a scale)
  and its relation notes (both ends), and the book's title and logline; not
  answers, research, versions or proposals yet. A plain-text source is never
  parsed as HTML again. THE STEMMER is `porter2Stem`, Snowball English
  written from `english.sbl` and held to Snowball's own 42,649-word
  vocabulary and output (`tests/fixtures/snowball/`); a change that moves a
  stem moves `PORTER2_VERSION` and re-pins `golden-pin.json`. The irregular
  table takes only forms that are almost always that lemma (no left, saw,
  rose, fell…), and a word it changes keeps its Porter2 stem too
  (`regularStem`: "broken" finds "brokenly"). It is NOT the question engine's `stem()` in
  `src/lib/interview/text.ts`, which grounding and dedupe depend on: neither
  imports the other (`tests/guards/search-stemmer-separate.test.ts`). Every
  word has a surface form (folded: NFKC, `'`, diacritics, possessive) and a
  stem; unquoted words match by stem (exact surface 1.0 above stem 0.6, an
  exact-case match of a capitalised query word 1.3: a signal, never a filter),
  a "quoted phrase" or quoted word is required and matched by surface. BM25F
  weights a name above a summary above field text. A source is tokenised only
  when its folded text holds a needle (`candidateNeedles`: a stem minus its
  last two characters and its irregular forms); keep that sound — the golden
  test checks the two-character property, and the rank test compares results
  with skipping off. Every read and the results are bounded
  (`vocabulary.ts`; every encrypted text — summaries, fields, relation notes
  and fields — is sized by stored bytes first and decrypted a bounded chunk at
  a time, Phase 3.H), and a cut is named (`coverage.cut`, `truncated`), never
  silent. PRIVACY: the query is author text — the route is a POST with a JSON
  body, never `?q=` (Next's own request span records `http.target` with the
  query string, a proxy's access log the URI), the page never puts it in its
  URL, and nothing logs, traces or audits it or a snippet
  (`privacy-sinks.test.ts` plants one). Snippets are plain text with
  highlight offsets; the client renders `<mark>` as React text. `bible.view`
  searches. Cost is linear in the book: the load test holds it to its own
  `WORD_SEARCH_P95_BOUND_MS`, and `book-search-work.test.ts` to counted work.
- **Story order, slots and locks (Phase 3.H; D25).** LOCK ORDER, for the whole
  book, is: (bundle import) → map → names → order → element → relation. Take
  them in that order and never one after a later one: a map save and restore
  take the order locks of the kinds the map draws right after the map's
  (`lockMapOrders`: a node's foreign key takes a KEY SHARE on its element's
  row, a rank change takes it FOR UPDATE); a bible deletion takes the map locks
  before the element's (`deleteElement`); `removeRelation` takes the map locks,
  then the relation's. A rank is placed only by `rankForTarget`
  (`bible-order.ts`): named neighbours must be placed (409 ORDER_STALE). The
  story order is ONE FREE ORDER per book and kind, the rank alone (D25 as the
  owner amended it): a beat in Act 2 may stand before one in Act 1, the plot
  board's act lanes each show their beats in that rank order, and 4.2 reads
  before and after from the rank alone, never act first. With no neighbour
  named a placed element keeps its rank (a beat moved into another act, an
  empty one included, changes only its act) and an unplaced one goes to the end
  of the order. A spent gap
  REBALANCES the whole order (`rebalancedRanks`, under the order's lock, one
  `BIBLE_ORDER_REBALANCED` audit row, no version: no place relative to another
  moves) and is placed again. AUDIT LAST: a placement writes its rows (the
  rebalance's, the element's rank) before the transaction's first audit row
  (`recordRebalance` after them; a slot's beat reserves its place with
  `reserveOrderPlaceTx` before it is created), because the audit lock is held
  to commit and a writer holding a beat's row appends one too (40P01). A whole-order read is `readPlacedOrder` (409
  ORDER_SCOPE_TOO_LARGE past `ORDER_SCOPE_MAX`, never a cut read); the import's
  ORDER_TAKEN check asks for the ranks it writes (`holdersOfRanks`). A slot's
  beat (`story-slot.ts`, kept off the dials' import graph) is placed as proposed
  only while its slot stands (`slotChangeOf`); otherwise 409 SLOT_CHANGED
  (`change`: NEIGHBOUR_GONE, NEIGHBOUR_UNPLACED, NEIGHBOUR_MOVED, GAP_FILLED) and
  the author names `placement: { after, before }` or `{ unplaced: true }`; the
  view's `slot.changed` and `slot.choices` drive `SlotPlacement`, which replaces
  Accept. A gap holds one beat (`slotBeat` / `slotTakenBy`: pending, or accepted and
  still there): reconcile refuses a second (`SLOT_TAKEN`), and the session GOES
  ON WITH IT (D25 as amended): later rounds ask about the beat's own fields, the
  subject still the beat not yet created (`aboutPending`, its name the beat's),
  what its proposal fills (and, once accepted, what its element holds) counted
  as stored (rule 5) and never challenged; reconcile proposes those fields as
  ADD-only FIELD proposals naming the beat's proposal (`targetProposalId`, no
  element, no base version; anything but ADD refused `SLOT_BEAT_ADD_ONLY`),
  accepted only after the beat (409 END_NOT_CREATED; a rejected beat or a
  deleted element 409 END_GONE), each writing one version of the created
  element naming its answers, never in bulk. The session ends when its frontier
  is empty. An accepted link returns `relationEnds`, which the map list draws
  from. Display text is cut with `truncateGraphemes` (`src/lib/text/truncate.ts`),
  never a UTF-16 slice.
- **The source library (Phase 4.0; D23, D26).** A source is a file read IN
  THE REQUEST (bounded `readBoundedBytes` at `SOURCE_UPLOAD_MAX_BYTES`, 20 MB;
  `assertUploadClean`; the format SNIFFED from the bytes, the name only telling
  Markdown from text) and kept only as encrypted, sanitised chunks of about
  1–2k tokens cut along chapters and scenes (`chunkBlocks`); never the file. A
  ZIP (DOCX, EPUB) is read only through `readZip`; ANY entry (whatever its
  name, UTF-8 or UTF-16) declaring an entity, or a DOCX part whose DOCTYPE has
  an internal subset or an external DTD, is refused `SOURCE_XML_REFUSED`; an
  EPUB's container and OPF are bounded (`EPUB_PACKAGE_MAX_BYTES`) before they
  are parsed. The sniff asks a ZIP's magic first, then `%PDF-` at byte 0, then
  text: a note or an archive that mentions `%PDF-` is never handed to the PDF
  reader. Mammoth (over a ZIP rebuilt from what `readZip` accepted, images
  never read) and the PDF reader run in `scripts/{docx,pdf}-text-worker.mjs`
  through `parse-worker.ts`, never on the request's thread: a deadline, a heap
  limit, the worker's heap AND external memory watched (decoded streams live
  outside the heap), at most two at once; the image copies both scripts (no
  OCR: `SOURCE_NO_TEXT_LAYER`). A heading past `HEADING_MAX_CHARS` is read as
  a paragraph, so no chunk passes its bound. Every
  refusal is a `details.reason` in `SOURCE_REFUSALS` and `sources.reasons`. The
  file name travels in the `x-source-filename` header, never the URL. A library
  holds at most `SOURCES_PER_LIBRARY_MAX` (50) sources (LIBRARY_FULL); the same
  text twice is refused (SOURCE_DUPLICATE, a unique keyed hash); a CHANGED file
  under a held name is the next `version` superseding the newest (`supersedesId`),
  and a fact of it making the SAME CLAIM (predicate, subject, object, statement
  and quote, folded; `carryKey`) carries the old decision (`carriedFromFactId`);
  a claim decided both ways carries nothing. The upload stores the cost
  (`cost.ts`: expected, and at most — the first attempt over the very request
  the call builds plus 2.1's one repair, so a repaired call is inside it) and
  sends nothing; INGESTION starts only when the author confirms the "at most"
  (`confirmWorstCaseMicroUsd`; less than the remaining chunks' worst case is 409
  ESTIMATE_CHANGED), which becomes the job's BUDGET, checked before each chunk
  with the same function over the same blocks. The
  `source-ingest` job (payload ids, `attempts: 1`) re-reads the requester's
  membership, embeds every chunk (`SourceChunk` is a vector source model, with
  the 2.0 delete and require-source triggers), then makes ONE fast-tier
  `callStructured` per chunk not yet read (`extractedAt` is the cursor:
  resumable), charging `chargeModelCalls` and WAITING out a limited minute (at
  most `MODEL_RATE_WAIT_MAX_MS`, then STOPPED PARTIAL `MODEL_RATE_LIMITED`:
  never a call that was not charged). A live source is stale (CLAIM_EXPIRED)
  only when its last sign of life (`heartbeatAt`: queued, claimed, every step)
  is older than `STALE_INGEST_MS`, never by its upload time; the claim
  (`startedAt`) is named by every write of its worker, so a stale claim queued
  again and claimed by another worker leaves the first writing nothing.
  CEILING, KILL_SWITCH, BUDGET, ABORTED and AI_UNAVAILABLE stop it STOPPED,
  resumable; a chunk's own failure leaves that chunk for a resume (PARTIAL); a
  guard refusal yields nothing for it. D11 applies (`sources/record-gate.ts`,
  503 SOURCE_FACTS_NOT_EVALUATED). Every fact cites an exact span `locateQuote`
  finds in its chunk (stored as the chunk's own slice) and passes
  `validateFacts` (subject named in the passage, grounding — a story time
  included, against the passage and its headings — polarity, no copied
  injection or prompt; D14: product-addressing text FLAGGED, never bulk-confirmed).
  NOTHING WRITES THE BIBLE: a fact is PENDING until the author decides
  (`bible.edit`; `bible.view` reads); only a CONFIRMED fact answers a field, and
  only through `PREDICATE_FIELDS` (`fieldAnsweredBy`; explicit, conservative;
  widening it is a reviewed change), as the frontier's `source-facts` check
  (`sourceFactsCheck`, in `loadInterviewState`). A BULK CONFIRM names only ids
  the view OFFERED (pending, unflagged, shown), signed by `view-token.ts`
  (VIEW_EXPIRED, FACTS_NOT_OFFERED) and re-checked in the database. A book
  draws on its own library and the SERIES sources it opted into
  (`bookSourceSet`) and on nothing else: the facts, the check and the retriever
  read only that set (a vector hit is read back through it). A book's override
  of an inherited CONFIRMED fact (409 OVERRIDE_NOT_INHERITED otherwise) is its
  own answer for that book; the series fact is untouched. The retriever
  (`assembleSourceContext`: confirmed facts, then vector + 3.4 lexical passages
  fused by rank, under `SOURCE_CONTEXT_TOKEN_BUDGET`) feeds the question
  generator's `source-facts` / `source-passages` data blocks only. 4.0 asks no
  confirmation question in the interview (the Facts page is the path; 4.4's
  source-question generator deepens it), and word search does not read chunks.
  `StoryFact` is the 4.1 model: extend it, never add a second fact table. After
  editing the extraction set, prompt or schema, re-run
  `npm run packs:evaluate -- --no-packs --sources`.
- **The fact layer (Phase 4.1; D27).** ONE fact table: a `StoryFact` is a
  SOURCE_CHUNK fact (4.0, PENDING until the author decides) or a bible fact —
  BIBLE_VERSION or RELATION_VERSION — drawn from an accepted version and stored
  CONFIRMED and `automatic`; CHECK `StoryFact_kind_columns` pairs each kind
  with its columns. A bible fact belongs to its element or relation (cascade:
  deleting either takes its facts and their proposals; the versions stay with
  the book), and a relation's removal retracts what it stated. THE OUTBOX: a
  trigger on each version table writes a `BibleFactExtraction` row (and an
  `EmbeddingTask` for the element) in the version's own transaction, so a
  rolled-back save leaves nothing; nothing on the request path enqueues. The
  minutely `fact-layer-dispatch` job queues due rows (settled for
  `FACT_EXTRACTION_SETTLE_MS`; STOPPED ones when due; stale QUEUED/RUNNING ones)
  as `bible-facts` jobs (payload ids), and only while a call can be made and a
  record mounts (D11) and the workspace's month has room for the least call
  (`modelBudgetState` over `bibleFactsCallFloor()`; with none, its rows wait
  STOPPED CEILING, `deferAtCeiling`, and resume oldest first); discovery is
  fair-shared between workspaces (`listDue`: an even share each, round-robin)
  and is the closed `fact-layer-discovery` bypass,
  ids only, and the mark asks the SAME due window in its own statement (never
  re-queue a row another tick queued: its claim is live). `executeBibleFactExtraction`
  SKIPS a superseded version (a newer one of the same entry covers it: a run of
  autosaves is read once), asked before the claim AND again at persist under the
  fact lock (an older version never writes after a newer one), a gone
  subject, a deleted book or an author who may no longer edit; STOPS
  (resumable, `nextAttemptAt`; a stop at the ceiling or the kill switch counts
  no attempt, D27 addendum) at the kill switch, the ceiling, the rate minute
  (waited at most `MODEL_RATE_WAIT_MAX_MS`, never an uncharged call), D11, a
  failed call; otherwise renders the version (`entry-text.ts`) and sends ONLY
  the sections changed since the entry's newest extracted version (its
  baseline) after the header, with the live facts about its subject(s) shown
  numbered, in BOUNDED fast calls (D27 addendum: `planBibleFactCalls`, pieces
  of at most `BIBLE_FACT_PIECE_MAX_CHARS` cut at block, sentence or space
  boundaries, each call's worst case — `bibleFactsCallWorstCase` — inside the
  per-call cost budget, which is ENFORCED for this prompt: halved, then no
  names, then fewer facts shown, else `CALL_OVER_BUDGET` and nothing sent; a
  rich-text value is read by 3.4's HTML reader, never fused across paragraphs);
  each call's cost is counted on the row in a transaction of its own. Validation is 4.0's (`validateFacts`) on the text each call was SHOWN, one item at
  a time, plus the entry's own: the subject must be the entry's element (a
  relation's ends), and the span is an offset into the WHOLE entry. Under
  `BibleFactRepository.lockBook`, `resolveFacts` (pure, `dedupe.ts`): a claim
  (`claimParts`, keyed by `claimKey` under the workspace subkey; polarity
  kept) a live fact already holds adds PROVENANCE, never a twin (partial unique
  `StoryFact_one_live_claim`); a new fact contradicting a live one by RULE (an
  AGE, LOCATION, OCCUPATION or PLACE_TYPE that plainly differs at an
  overlapping story time — since the D28 addendum a LOCATION only when both
  facts carry a time or a story position; never a ROLE or a WANT) or by the MODEL (an existing
  fact it was shown, same subject element) raises a PROPOSAL; an earlier fact
  of the same entry whose quote is gone raises NO_LONGER_STATED. NOTHING IS
  INVALIDATED by the job (rule 1): the author decides on the Facts page
  (`decideFactProposal`, `bible.edit`): INVALIDATE sets `supersededAt` and
  `invalidatedByFactId` once (trigger; the pointer is cleared only by its
  foreign key's SET NULL, never while the newer fact stands) and settles the fact's other pending
  proposals; KEEP_BOTH and REJECT write only the decision; one proposal per
  pair, ever (NULLS NOT DISTINCT). Series facts are never resolved against
  (shared with other books). The book's fact lock (`story-facts:<bookId>`) is
  taken alone, never with a bible lock, and audit is last. Bible facts answer fields at once
  through `PREDICATE_FIELDS` (`bibleFactsCheck`, `bible-facts` in
  `answered[].by`; 4.1 adds only WORLD_RULE's RULE), and only while the fact's
  quote is still in its entry AS IT STANDS (D27 addendum: `currentEntryTexts`,
  the newest version of at most `BIBLE_FACT_OWNERS_VERIFIED_MAX` entries, one
  snapshot decrypted each; a cleared field is asked again at once, the fact
  itself waiting for the author's NO_LONGER_STATED decision). EMBEDDINGS: elements, facts
  and ANSWERED answers are vector source models (delete triggers; the
  require-source guard, an append-only answer's without a lock); the
  dispatcher embeds each `EmbeddingTask` as its row stands, never on a request;
  a repeat bumps the task's `generation`, and a task is deleted only at the
  generation that was read (a save mid-embedding is embedded again). A source
  fact the author invalidated carries no decision into its source's next version.
  THE CONTEXT (`assembleSourceContext`): one token budget — related summaries
  (their share), top `FACTS_TOP_K` facts (the scope's bible facts, its confirmed
  source facts, then the nearest of the book's others — a series fact the book
  overrode as its override text, by either path), then vector + lexical
  passages fused by rank; every vector search names its allowed set INSIDE the
  query (`within`: `chunks-of-sources`, `facts-of-book`), the in-process backend
  refuses it. With an embedder, a round's context is read AFTER the claim: the
  query (`contextQueryText`) embedded outside every transaction, then one
  transaction more (`interview-latency.test.ts`), inside the generation's
  `try` (a context that cannot be read FAILS the round; a failed vector search
  falls back to the lexical context). `StoryFactProvenance` is append-only by
  grant as well as by trigger. The worker aborts running
  ingestions and extractions on shutdown (`abortRunningJobs`). After editing the
  set, the prompt or its schema, re-run `npm run packs:evaluate -- --no-packs
  --bible-facts`; a changed `QUESTION_PROMPT` needs `npm run packs:evaluate`.
- **Continuity (Phase 4.2; D28).** CONTRADICTIONS live in `StoryFactProposal`
  (never a second table): a `kind` (VALUE, WHEREABOUTS, KNOWLEDGE, TIMELINE,
  OTHER) and a basis (RULE, MODEL, DEEP with its `checkRunId`); before and after
  come from the story order's ranks alone (`storyClock`, D25), a text story time
  second. The rules (`rules.ts`) need one linked subject element and are narrow;
  one pair is raised once in either order. WHEREABOUTS and KNOWLEDGE clash only
  when BOTH facts carry an overlap-decidable time (`decidedOverlap`: a story
  time, or a position in one order); a fact with neither is the deep check's
  (D28 addendum, item 2). VALUE keeps "unknown overlaps everything" (few
  distinct values per subject). `CONTINUITY_PROPOSALS_PER_RUN_MAX` (1,000 a
  book a night) is a safety bound and should rarely bind. The
  author decides (`bible.edit`): keep the newer (`INVALIDATE`), keep the older
  (`INVALIDATE_NEWER`), both true (`KEEP_BOTH`, an explanation REQUIRED on a
  contradiction, stored as a CONFIRMED `AUTHOR_RESOLUTION` fact naming the
  proposal through the fact sanitiser), or not a contradiction (`REJECT`).
  THE NIGHTLY CHECK (`continuity-dispatch` at 02:23 UTC, fair-share discovery
  under the closed `continuity-discovery` bypass, ids only; one
  `continuity-check` per book with a live fact newer than its `coveredThrough`)
  sweeps CLEARED flags, runs the rules over the whole book (bounded), then deep
  calls by `planNight`: at most `CONTINUITY_CALLS_PER_NIGHT` (2) of at most
  `FACTS_PER_CALL_MAX` (100) facts, a subject's facts together, from a stored
  cursor (`kind:id`; never author text in a cursor), each call's worst case
  inside the ENFORCED per-call budget (cut, halved, else `CALL_OVER_BUDGET`),
  each charged to `chargeModelCalls`; the cursor is saved after every call.
  A pass covers facts stamped up to `CONTINUITY_PASS_SETTLE_MS` (15 min) before
  its claim, never the claim itself (a fact stamped before it may commit after
  the read); the rest are the next pass's.
  A workspace's deep calls spend at most `CONTINUITY_NIGHTLY_SHARE` (10 %) of
  its monthly ceiling a night (D28 addendum, item 1): measured from the ledger
  (calls of purpose `continuity.deep-check` charged in the night's window plus
  their live reservations, which carry `purpose`), checked before each call
  with its worst case and again by `workspaceAiLedger(ctx, share)` under the
  spend lock (`limit: 'NIGHTLY_SHARE'`); past it the night stops `NIGHTLY_CAP`.
  A stop (ceiling, nightly share, kill switch, D11, the rate minute, abort)
  keeps the cursor and is never FAILED; the rules run even when D11 refuses the model; findings are
  only proposed. A run lost by its worker (`STALE_CONTINUITY_RUN_MS`) is ended
  and the book queued again. THE REGISTRIES are one `StoryThread` table (kind,
  kind-checked state, encrypted title and note, optimistic `version`, no
  version table: the audit trail is its history). Threads are proposed by 4.1's
  bible fact call (its output's `threads`, shown the open threads so it can say
  one was paid off; `validateBibleThreads`, D14 flags), keyed once per book ever;
  the author accepts, rejects, adds, edits, changes the state and removes (undo
  toast). Open questions also list DECIDE_LATER answers whose field is empty and
  pending contradictions, derived, never stored. PROPAGATION DEBT: the trigger
  `bible_entry_version_stale_flags` raises, in the version's transaction, one
  `StaleFlag` per (entry, upstream) for every OTHER element whose versions name
  an ANSWERED answer to a question about the changed element (its own, or a
  relation's with it at an end; never `aboutPending`); a reorder raises nothing;
  nothing transitive. Only that trigger raises or re-raises a flag
  (`stale_flag_guard`, by `pg_trigger_depth()`): a statement may only dismiss
  or clear an OPEN flag, every other column unchanged, and only a cascade
  deletes one (app_user holds no DELETE). A flag stands while its entry has not been saved since
  (`standingStaleFlags`, read; the sweep writes CLEARED) and until dismissed; a
  later change re-raises it. "Grill me on what changed" is a SELECTION session
  of that one element with `staleFlagId` (409 STALE_FLAG_GONE otherwise), depth
  5, its stale fields challenged first, the upstream entry before and after as
  the `upstream-change` data block. After editing the continuity set, prompt or
  schema, re-run `npm run packs:evaluate -- --no-packs --continuity`; the bible
  facts prompt carries the threads (`--bible-facts`).
- **Book-level interrogation (Phase 4.3; D29).** NOTHING HERE WRITES THE
  BIBLE: every path ends in questions. THE STRESS TEST runs only on the
  author's confirmation of its "at most" (`confirmWorstCaseMicroUsd`; less is
  409 ESTIMATE_CHANGED), which is 2.1's worst case (first attempt plus one
  repair) over the very blocks the call will send; `fitStressInput` halves the
  input until that fits the template's per-call budget, else
  `CALL_OVER_BUDGET` and nothing is sent. One live test a book (advisory lock
  `stress-test:<bookId>`, 409 STRESS_TEST_IN_PROGRESS). The `stress-test` job
  (payload ids, `attempts: 1`) re-reads the book and refits: a worst case above
  the confirmed one stops it STOPPED ESTIMATE_CHANGED with nothing sent; the
  ceiling, the kill switch, D11 (503 STRESS_TEST_NOT_EVALUATED at start), the
  rate minute (waited at most `MODEL_RATE_WAIT_MAX_MS`) and an abort stop it
  with a named outcome; a test whose worker died is CLAIM_EXPIRED after
  `STALE_STRESS_TEST_MS`. Its input is `buildStressInput`: one character
  budget in shares across the book, elements, story order, 4.1's top facts,
  open threads and passages, each shown row given a TAG (`E1`, `F1`, `T1`,
  `P1`) and counted when cut (`coverage`, shown with the estimate and the run).
  The model cites tags, never ids; code maps them back and refuses a weak point
  with an unknown tag (rule 2), and drops a citation whose row is gone at
  persist (CITATION_GONE when none is left). `validateWeakPoints` holds the
  rest, in its header's order: questions or nothing (one question, its only
  question mark), no rewrite (a quoted run past `QUOTED_RUN_WORDS_MAX` words
  the book does not hold), no invented name (INVENTS_NAME), no copied
  instruction or prompt; D14 flags. A session from a stress test is a
  SELECTION of the cited elements and cited facts' subjects with
  `stressTestId` (`requireStressTestForSession`; STRESS_SCOPE_MISMATCH), its
  weak points a `weak-points` data block, their fields challenged first. THE
  GAP HUNT's candidates are code (`computeGapCandidates`; the score in
  `candidates.ts`'s header); the model only orders the top
  `GAP_CANDIDATES_MAX`, each reason naming a candidate it cites
  (`namesCandidate`); with no call possible, or nothing valid, the code's order
  is stored and shown UNRANKED with its reason (`GAP_UNRANKED_REASONS`), never
  as the model's. On demand only, never scheduled; a book keeps its newest
  `GAP_HUNTS_LISTED_MAX`. THE PANEL is the three `panel-*` persona packs,
  offered only by the setup sheet's Panel preset (`panelSetup` /
  `isPanelSetup` in `setup.ts`), never in the picker or the defaults (the
  defaults' schema and CHECK refuse a panel key; a session's list names all
  three panel personas or none of them, so no panel voice sits beside its
  namesake); a
  persona pack may carry its own `situations.json` (`personaSituations`,
  hashed and scanned like the shared one). Questions are grouped by
  `groupByPersona` on the session and review pages. COMPACTION
  (`compactedSessionFor`) rebuilds the request after it BY CODE
  (`buildSessionState`: scope, pinned packs, every earlier answer and accepted
  change verbatim, refusals by code) beside the model's summary fenced as model
  text; never move any of those into the summary. The summary is an ordinary
  `callStructured` call (ceiling, kill switch, D11, guard, the round's signal),
  made only when the session's token budget takes its worst case
  (`compactionCallWorstTokens`) beside the round it serves, stored once
  per session and range; any failure leaves the round uncompacted.
  `COMPACTION_ON_BY_DEFAULT` is true since 4.4 (D30). All three prompts follow D11
  with their own records; after editing a set, prompt or schema, re-run
  `npm run packs:evaluate -- --no-packs --book-level`, and after the question
  prompt, `npm run packs:evaluate` (and `--rephrase`).
- **Continuous, deep questioning (Phase 4.4; D23, D30).** THE FRONTIER IS ONE
  GENERATOR AMONG FIVE (`src/lib/interview/generators/`, pure; inputs loaded
  by `interview-generators.ts`, every read bounded and keyed by the book): the
  frontier (model-worded by the unchanged QUESTION_PROMPT, the pack fallback
  behind it), the deepening LADDER (follow-ups on an answered prose field,
  layer by layer WHAT → WHY → COST → WHO_KNOWS → BREAKS → EDGE_CASES; a layer
  answered anywhere in the book, or asked in this session, is held — rule 5 —
  and the depth dial sets how far down, `ladderDepthFor`; its answer deepens
  that same field through reconcile), RELATIONS (a KIND/BOOK session's relations
  between two scope elements become subjects when it pinned the relations pack,
  and PAIRS of the scope's characters and factions with no relation yet, at
  most `PAIRS_PER_ROUND_MAX` a round, filed under the first element with
  `pairElementId`; reconcile treats a pair's two elements as relation ends, so
  an answer may become a NEW_RELATION the author decides), SOURCES (a PENDING,
  unflagged fact of `bookSourceSet` about a scope element, quoted, yes/no; the
  round's close decides it through `decideFactInTx`, the one writer of a fact's
  decision, naming the answer — `decidedByAnswerId` — only while still pending
  and unflagged; reconcile never reads a source question; a source question
  whose predicate answers no field targets none, the only question allowed zero
  targets) and CONTINUITY (pending CONTRADICTED proposals, OPEN threads landing
  in `THREAD_LANDING_FIELDS`, timeline gaps). Every candidate has a CODE value
  score (`value.ts`), and `selectCandidates` validates, deduplicates (one per
  field, fact and basis a round, the higher value winning) and orders them best
  value first, cut to the round's room; produceRound then deduplicates the
  wording as ever. The four new generators' questions are WORDED BY CODE
  (`wording.ts`, origin GENERATOR; the author's quotes verbatim, a `?` inside
  them full-width; never re-worded — 409 QUESTION_NOT_REPHRASABLE); the stored
  plan names them by id and field, never their text (the owner kept code wording
  for 4.4, D30, and again in 4.H, D31: personas word only the frontier's questions,
  revisited only after real-model evaluation records exist). A candidate below
  `MINOR_VALUE_FLOOR` is minor: a round asks only what is above it, and when only
  minor candidates are left the session PAUSES `VALUE_FELL` (last in the
  precedence) until the author says go on (`goOn: true` on the next round sets
  `minorAccepted`); never padding. HOLD FOLLOW-UPS (owner decision 2026-11-26, D30): no generator —
  the frontier's question and a challenge included — asks about a field while an
  enrichment proposal for it is PENDING (an element's FIELD, a relation's
  RELATION_FIELD, a pair's pending NEW_RELATION holding both its fields;
  `pendingFieldHolds` → `heldByProposals` → `selectCandidates`' `held`); when only
  held candidates are left the session PAUSES `AWAITING_DECISIONS` and the next
  round resumes it once the author decides. A SERIES source's fact is still decided
  from the interview for every book that uses it, and its question says so
  (`sourceQuestion(…, series)`, angle `SERIES`, the "Series fact" badge). A closing
  round writes its facts' decisions first and their audit rows last
  (`decideFactsFromRound(…).audit()`): an audit row before a fact row deadlocks
  with a Facts-page decision. THE TIE-BREAK (`QUESTION_ORDER_PROMPT`, fast,
  D11, enforced per-call budget, charged to `chargeModelCalls` and the session's
  budget) may reorder only the round's first run of near-equal candidates
  (`tieGroups`); its answer counts only as an exact permutation, else the code's
  order stands and `metrics.order` says why. SESSION LENGTH is the author's
  (`session-length.ts`: ROUNDS 1..30, QUESTIONS 1..300, UNTIL_STOPPED; default
  four rounds); the six-round limit and depth's round table are gone; every
  session still stops at its token budget, the ceiling, the kill switch, the
  author and SESSION_LIMIT (one more worst round past `SESSION_QUESTIONS_MAX`);
  a round of code-worded questions alone needs no model call, so the kill switch
  and the ceiling do not pause it; a spent question budget is QUESTION_BUDGET,
  never FRONTIER_EMPTY. On the session page code-worded questions are their own
  group (`CODE_WORDED_GROUP`), never "the craft guidance". THE HARD REPETITION GATE: a round's persist
  and a rephrase take `lockBookQuestions` after the session's lock and drop any
  question the book already holds in those words (`withoutRepeats`, which never
  fails open). `generatorsOff` is a dial (session, book, workspace, code; at
  least one on). COMPACTION is ON (`COMPACTION_ON_BY_DEFAULT`), its summary's
  worst case reserved beside the round (`compactionReserveTokens`) and a share in
  every budget. After editing the tie-break's set, prompt or schema, re-run
  `npm run packs:evaluate -- --no-packs --question-order`.
- **Hardening Phase 4 (4.H-a; D31).** IDEMPOTENT EXTRACTION: a bible version
  extracted again writes nothing — its own facts are held by claim key and gain
  no provenance row from the version that first stated them; a source ingested
  again reads no chunk (`extractedAt`). The live facts a version is resolved
  against are read BY CLAIM KEY first (`BibleFactRepository.listLiveByKeys`),
  then by subject up to `LIVE_FACTS_READ_MAX`, so a held claim past the cap gets
  provenance and never hits `StoryFact_one_live_claim`. A call the guard
  refuses (or that repeats the prompt) yields nothing for ITS piece only; the
  run goes on, and a version every call of which was refused still ends DONE
  (outcome GUARD_REFUSED / REPEATS_PROMPT), so it is the entry's baseline and the
  refused text is sent again only once it changes. Invalidating a fact settles
  every pending proposal it stands in, older or newer (`settleAllForFact`). An
  ingestion that read every chunk but whose embedding FAILED (the provider
  answered a failure, not "none configured") stops STOPPED `PARTIAL` with
  `EMBEDDING_FAILED` (`awaitsEmbedding`), resumable at a zero "at most": the
  resume only embeds. An upload re-checks its book in the write's own
  transaction, its row `FOR SHARE` (`findLiveForShare`). The parse worker's
  watchdog also reads the PROCESS's resident memory while a heap read has gone
  unanswered for `MEMORY_STALL_MS` (a worker held in one native call), measured
  from the worker's `online`. THE NIGHTLY CHECK: a dispatch is for one night
  (`continuityNightKey`, the UTC date 12 h before it); a book with a run for
  that night is not due, and `ContinuityRun_one_a_night` (partial unique) holds
  it under concurrency. A page whose call is over the per-call budget, or whose
  answer is never valid (INVALID_OUTPUT, PROMPT_INVALID — never a timeout or an
  outage), counts a failed night (`pageFailures`); after
  `CONTINUITY_PAGE_FAILURES_MAX` (3) in a row its subjects are PASSED OVER
  (cursor past them, `parkedSubjects`, reset when a new pass starts). The
  Continuity page's `nightly.complete` is true only for a finished pass with
  nothing cut (`factsCut`, the last run's metrics), nothing passed over and at
  least one live fact; the page never says "every fact checked" otherwise. A
  "Grill me on what changed" session carries `staleFlagId` and has its own
  heading (`titleStale`). QUESTIONING: the hold on fields with a pending
  proposal is read again at persist (`fieldHoldsFor` in `stillAskable`); the
  hard repetition gate probes the database for a BETWEEN slot's beat too
  (`pendingIn`: the session's earlier questions about it, never another
  session's); the ladder's history is read a page at a time
  (`GENERATOR_HISTORY_PAGE`) up to `GENERATOR_HISTORY_READ_MAX`, and past it
  the cut is named (`historyCut` in the round's plan) and the ladder and the
  pair questions ask nothing that round; a "decide later" pair question names
  the pair on the Continuity page (`pair`, open while the two hold no
  relation). `Question.storyFactId` and `StoryFact.decidedByAnswerId` are
  composite `(workspaceId, id)` keys whose deletion sets only the id NULL
  (`SET NULL (col)` in the migration; the Prisma relation says `NoAction`,
  which Prisma cannot spell otherwise). The gap hunt counts a relation between
  two elements of one kind once. EVERY D11 GATE is reported at start
  (`recordGateReports`): a new gate joins `GATE_REPORTS`
  (`tests/unit/platform/startup-record-gates.test.ts`). A model record's
  "copied reference" check refuses only when EVERY case whose reference names
  something holds the reference answer (continuity's like 4.3's stress test and
  2.5's reconcile). VECTORS are derivatives of encrypted-at-rest columns,
  deleted with their source row (`docs/rls-workspace-isolation.md`); a new
  vector source model joins `tests/integration/embedding-deletion.test.ts`, and
  a new surface that feeds a model a book's context joins
  `retrieval-isolation.test.ts`.
- **Sanitising author text.** Every author-text write sanitises at the
  usecase layer before it is stored: plain text through `plainLine` /
  `plainBlock` (`src/lib/bible/text.ts`, over `sanitizePlainText`), rich text
  through `sanitizeRichTextHtml`, field values through `normaliseFieldValue`.
  Raw input is bounded BEFORE it is sanitised (at most `RAW_INPUT_FACTOR`, 4,
  times the stored bound: the request schema for every input, and each field
  type's own raw bound in `normaliseFieldValue`), so refusing a huge value
  costs a length check, not a parse. Control characters (C0 but tab, LF, CR;
  and DEL) are stripped from what the sanitiser returns: PostgreSQL refuses a
  NUL in a text column, and `&#0;` decodes to one.
  An encrypted-manifest field must be classified in
  `tests/guards/encrypted-field-sanitiser-coverage.test.ts` with the sanitiser
  its writers call; that guard fails for a field, or a new caller of its
  repository's write method, without one, for a second Prisma write path, and
  for any other write method of the repository whose `data` names the field
  or cannot be read (Phase 1.H).
  `sanitize-html` and its parser are ESM: the unit and integration Jest
  projects transform them (`NODE_ESM_ALLOW_LIST` in `jest.config.js`).
- **Request bodies.** A route reads its body with `readJsonBody(req)`
  (`src/lib/http/json-body.ts`), or a non-JSON body with
  `readBoundedBytes(req, max)` (`bounded-body.ts`), never `req.json()` /
  `req.text()` / `req.arrayBuffer()` / `req.formData()`: a malformed
  body is a 400, and a body past `JSON_BODY_MAX_BYTES` (2 MiB) is a 413
  without being read in full (refused on its `content-length`, or cut off
  once the streamed bytes pass the cap). A numeric query or path parameter
  that reaches an `Int` column is bounded to PostgreSQL's integer
  (`VersionNumberParam`), or an out-of-range value is a P2020 500.
- **Security headers.** The proxy stamps a per-request-nonce CSP (script-src
  `'nonce-…' 'strict-dynamic'`, no `unsafe-inline`; style-src `unsafe-inline`
  and no nonce) and `SECURITY_HEADERS` (`src/lib/security/csp.ts`) on every
  response it returns; `next.config.mjs` repeats the headers, with
  `STATIC_ASSET_CSP`, for `/_next/static/:path+` and exactly `/_next/image`,
  the only paths the proxy's matcher (`(?!_next/static/.|_next/image$)`) skips.
  The two partition every path (`tests/unit/platform/proxy-matcher.test.ts`,
  with Next's own compilers): change them together, never as a bare prefix. Every inline `<script>` takes the nonce from `x-csp-nonce`
  (the root layout's two do). A new origin is added to the policy in the change
  that needs it, never as a wildcard; the one other origin today is tldraw's
  watermark-track fetch, ONE full URL in `connect-src`
  (`TLDRAW_WATERMARK_TRACK_URL`, D20; it moves with the tldraw version). `tests/e2e/security-headers.spec.ts`
  checks every kind of response, both copies of the list, and a browser walk
  with no violation.
- **Probes.** `/api/health` and `/api/livez` (process up) and `/api/readyz`
  (PostgreSQL and Redis within a 2 s timeout, 503 naming the failure) are
  unauthenticated and excluded from rate limiting.
- **Secrets.** `.husky/pre-commit` runs `scripts/detect-secrets.sh` on staged
  files (`tests/unit/pre-commit-hook.test.ts` drives it through a real `git
  commit`); `tests/guards/no-secrets.test.ts` runs the same `.secret-patterns`
  over the whole tree. A test fixture that must look like a secret goes under
  `tests/fixtures/secrets/` or carries `# pragma: allowlist secret`.
- **Docs site.** `site/manifest.json` is an allowlist and only `docs/user/` is
  published; the roadmap and internal docs never are.
- **`any`** is an ESLint error. There is no debt to ratchet.
- **Licence.** Inkquisitor is BUSL-1.1 (`LICENSE`, explained in
  `LICENSING.md`). The header and Terms of `LICENSE` are pinned byte-for-byte by
  `tests/unit/licence.test.ts`; only the Parameters block may change, and only
  by owner decision. Third-party ports (MIT / Apache-2.0) are credited in
  `NOTICE` in the change that ports them.
- **Carve manifest.** Copy whole files where possible, then edit. Add a row to
  `docs/carve-manifest.md` (Inkquisitor path, source path, source commit, edits
  made) for every file copied or adapted; `tests/unit/carve-manifest.test.ts`
  checks every listed path exists.

## UI platform (Phase 0.2)

Lifted from inflect-compliance (Epics 51–60); `docs/implementation-notes/2026-11-18-0.2-ui-platform.md`
has the design. Reach for the primitives, never hand-roll a replacement:

- **Colour comes only from the tokens** in `src/styles/tokens.css` (ink
  black, parchment, one violet-ink accent; both themes define every token)
  through the semantic utilities in `tailwind.config.js` (`bg-bg-default`,
  `text-content-muted`, `border-border-subtle`, `bg-[var(--brand-default)]`).
  No hex literal, no palette-scale utility (`bg-slate-800`), no hand-rolled
  `fixed inset-0` overlay or raw `role="dialog"` — use `<Modal>` / `<Sheet>`
  (`tests/guards/ui-colour-discipline.test.ts`). Text pairs are held to WCAG
  AA, and `--border-strong` (the checkbox/radio edge) to 3:1, in both themes
  (`tests/unit/design-tokens.test.ts`).
- **Primitives**: `<DataTable>` (`@/components/ui/table`), the filter system
  (`@/components/ui/filter` + `FilterToolbar`), `<Modal>`, `<Sheet>`,
  `<Combobox>`, `<FormField>`, `<Tooltip>`, `<DatePicker>` /
  `<DateRangePicker>`, `<Accordion>`, `<RadioGroup>`, `<ToggleGroup>`,
  `useToastWithUndo()` for destructive actions, `<RichTextEditor>`,
  `<VersionDiff>`, the hooks barrel `@/components/ui/hooks`, the visx chart
  platform (`@inkquisitor/ui/components/ui/charts`, colours from the
  `--chart-series-*` tokens). Shells: `<AppShell>`, `<ListPageShell>`,
  `<EntityListPage>`, `<EntityDetailLayout>`, `<DashboardLayout>`,
  `<WorkspaceShell>` (canvas pages), `<PageHeader>`. Shortcuts go
  through `useKeyboardShortcut`, never a raw `keydown` listener.
- **Package imports** use the deep path, `@inkquisitor/ui/components/ui/…`;
  nothing in `packages/ui` imports from `@/`.
- **`/dev/kitchen-sink`** renders every primitive and is a 404 in production.
  A new primitive is added to `KITCHEN_SINK_PRIMITIVES` and gets a probe in
  `tests/rendered/kitchen-sink.test.tsx` (the probe map is exhaustive, so
  `tsc` asks for it) and a behavioural suite of its own (every primitive the
  sink shows has one today: ported from inflect where inflect had one,
  written new where it did not). A probe drives the primitive and asserts
  what only it produces, never the sink's own trigger button.
- **`WorkspaceContext`** (`src/lib/workspace/workspace-context.tsx`) is the
  one context the chrome reads; do not change its exported interface. The
  `/w/[workspaceSlug]` layout feeds it from `getCurrentWorkspace(slug)`
  (`current-workspace.ts`, the session and a database membership check). Shell
  components read `useOptionalWorkspace()` and render a signed-out state for
  `null` (the dev kitchen sink). The command palette is mounted above that
  provider and reads the slug from the URL.
- **`<RichTextEditor>`** reports edits through `onChange` and a mode switch
  through `onModeChange` (never an edit); `disabled` disables every toolbar
  button. The detail layout's tabs are one tab stop with arrow keys (WAI-ARIA
  tabs). `<InitialsAvatar>` paints its initials from `data-initials`, so a
  control holding one is named by its label alone (axe label-in-name).
  Muted, not subtle, text on cards (contrast; the E2E axe pass checks it).
- **UI strings** go through next-intl (`useTranslations`), from
  `messages/en.json`; the locale is a cookie (`inkquisitor_locale`), no URL
  routing. Add only keys something reads.
- **Icons**: lucide-react or the package's own set. The Nucleo set inflect
  uses is licensed only for inflect and is not carried.

## Testing

- **Unit** (`tests/unit`, `tests/guards`): Node environment, no database, no
  network. `@/env` and `@/env-client` map to `tests/mocks/env.ts` (the real
  modules depend on an ESM-only package); stylesheets map to an empty module.
- **Rendered** (`tests/rendered`, plus co-located `__tests__` in
  `src/` and `packages/ui/src`): jsdom, Testing Library, jest-dom, jest-axe.
  `__mocks__/next-intl.js` answers from `messages/en.json`; `vaul` maps to a
  Radix-backed stub (`tests/rendered/vaul-mock.tsx`).
- **Integration** (`tests/integration`): a real PostgreSQL with pgvector 0.8+
  (the compose stack's, or CI's built image), never a mocked
  Prisma. Its environment (`tests/helpers/open-handle-environment.ts`) fails a
  file that leaves a socket, pool, server or ref'd timer open after its
  `afterAll`s: close what a file opens (`closeRedisClient`, `$disconnect`). `DATABASE_URL` from the shell wins; otherwise `jest.setup.js` uses
  `postgresql://postgres:postgres@localhost:5432/inkquisitor_test`. An
  integration test never skips because the database is missing: it fails.
- **Integration fixtures**: `tests/helpers/workspaces.ts` creates accounts
  through the real provisioning path, with unique emails; never clean
  `AuditLog` (it is append-only by trigger).
- **Accessibility** (`tests/e2e/bible-a11y.spec.ts`): axe (WCAG 2.1 A/AA,
  `@axe-core/playwright`, after entrance animations finish) on every bible page
  and dialog, and a keyboard-only walk (create, edit, relate, restore) that
  moves focus with Tab and acts with keys alone. A new bible page or dialog
  joins the axe list.
- **E2E** (`tests/e2e`): Playwright against a production build, against the
  database `DATABASE_URL` names (migrations applied), on `E2E_PORT` (3100).
  `production-refusal.spec.ts` starts a second server on port 0 without the
  two production secrets and expects it to exit 1. `playwright.config.ts`
  gives the server obviously-fake production secrets, no breach check and no
  rate limits; a spec signs up its own unique account (`tests/e2e/helpers.ts`).
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (read only by `playwright.config.ts`)
  launches another Chromium binary when the expected build is not installed.
- **No test calls a model provider or any network service.** `jest.setup.js`
  clears `ANTHROPIC_API_KEY` and silences logs (a suite that reads log lines
  builds a logger against its own destination). Integration tests use Redis
  logical database 14 (`tests/helpers/test-redis.ts`) and a queue name of
  their own.
- ESLint rules live in `eslint-rules/` with a `RuleTester` suite each
  (`valid` and `invalid` cases); see `eslint-rules/README.md`.
- A guard that scans source takes its file population from git through
  `tests/helpers/repo-files.ts`, never a hand-written skip list.
- Write tests that fail when the behaviour regresses, not tests that pin the
  shape of a diff.
- No test's verdict rests on a wall clock it does not control: a suite that
  counts bcrypt compares hashes at bcrypt's lowest cost (the production cost is
  pinned by `passwords.test.ts`); at cost 12, thirteen compares in one test ran
  past Jest's 5 s under load (`credentials-lockout`, 3.H).

## Implementation notes

Every subphase lands a note at
`docs/implementation-notes/<YYYY-MM-DD>-<subphase-id>-<slug>.md`: design, files,
decisions and trade-offs. No test counts — the test files are the record.
