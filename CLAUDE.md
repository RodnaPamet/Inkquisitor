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
npm start                 # next start (after build)
npm run worker            # BullMQ worker from source (tsx; loads .env then .env.local, as next dev does)
npm run build:worker      # esbuild → dist/worker.mjs, dist/worker-healthcheck.mjs
npm run secret-scan       # scripts/detect-secrets.sh (staged files; --all for every tracked file)
npm run docs:build        # the Starlight help site (site/), from docs/user/
npm run lint              # eslint . (flat config, eslint.config.mjs)
npm run typecheck         # tsc --noEmit, then packages/ui alone (no `@/` imports there)
npm test                  # Jest, unit (tests/unit, tests/guards, eslint-rules/__tests__) + rendered projects — no DB, no network
npm run test:integration  # Jest, integration project (tests/integration) — real PostgreSQL and Redis
npm run test:e2e          # Playwright against `next start` on :3100 (build first)
npm run db:generate       # prisma generate (also the postinstall step)
npm run db:migrate        # prisma migrate dev
docker compose up -d      # Postgres + pgvector, PgBouncer, Redis, ClamAV
```

Every one of `lint`, `typecheck`, `test`, `test:integration` and `build` must
pass before a change is finished. CI (`.github/workflows/ci.yml`) runs them as
the checks **Lint**, **Typecheck**, **Test** (unit, migrations, integration
against postgres:16 and Redis) and **Build** (app and worker bundle), plus
**Security** (`npm audit --omit=dev --audit-level=moderate` and the secret
scan), **CodeQL** (javascript-typescript; the SARIF is kept as an artifact and
`scripts/sarif-gate.js` fails the check on a high-severity security result)
**Docker** (image build, Trivy
CRITICAL,HIGH, ignore-unfixed) and **E2E** (Playwright against the production
build, with Postgres and Redis; the report is kept as an artifact on failure). The job names are the check names, so never
rename one, and never lower a gate to get a change through
(`tests/unit/ci-workflow.test.ts`). `release.yml` tags and publishes a GitHub
Release from conventional commits with GITHUB_TOKEN alone; `docs-site.yml`
builds the help site and deploys it only on main when Pages is enabled.

## Stack

Node 24, Next.js 16 (App Router), React 19, TypeScript strict, Tailwind 4,
Prisma 7 with a multi-file schema folder, Zod 4, `@t3-oss/env-nextjs`, Jest 30,
Playwright, ESLint 9 flat config. Versions are kept in step with
inflect-compliance; read the exact ones off `package.json`. tldraw, when it
arrives in Phase 3, stays pinned to 3.x with the watermark on (decision D1).

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
src/middleware.ts            → auth + read rate-limit tiers, x-request-id (and, from 0.3, the workspace gate)
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
src/lib/auth/                → passwords, credentials (lockout), session-revoked, workspace-gate (edge), membership claims, redirect-path
src/lib/db/                  → rls-middleware (runInWorkspaceContext, runWithoutRls), rls-tripwire, db-context, encryption-middleware
src/lib/security/            → encryption, workspace keys, encrypted-fields manifest, sentinel, session-tracker, password-check (HIBP), permission-middleware
src/lib/audit/               → the hash-chained audit writer and user-level auth events
src/app/login, signup, signout, no-workspace; src/app/w/[workspaceSlug]/ (books, settings)
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
only under zero-retention terms (D5).

## Conventions

- **Environment.** Server variables are declared in `src/env.ts` and read as
  `env.X`, never `process.env.X` (tooling configs such as `prisma.config.ts`
  and `playwright.config.ts` are the exception). `NEXT_PUBLIC_` variables live
  in `src/env-client.ts`, the only env module a `'use client'` file may import
  (`tests/guards/client-modules-import-no-server-env.test.ts`). Add a variable
  in the same change as the code that reads it, and list it in `.env.example`
  (`tests/unit/env-example.test.ts`). `SKIP_ENV_VALIDATION=1` skips validation
  for builds and tests; never put a real secret in CI or an image.
- **Database.** `DATABASE_URL` is the runtime connection (PgBouncer in the
  compose stack); `DIRECT_DATABASE_URL` is for `prisma migrate`, read by
  `prisma.config.ts`, which loads `.env` itself because the Prisma 7 CLI does
  not. Every port `docker-compose.yml` publishes is bound to 127.0.0.1.
  Prisma 7 needs a driver adapter: construct clients through `src/lib/db.ts`. New models go in a domain file under
  `prisma/schema/`, never in `base.prisma`.
- **Logging.** No `console.*` under `src/` (ESLint error; the edge logger is
  the one exception). Log through `logger` from `@/lib/observability/logger`
  (`edgeLogger` in middleware). Author text never reaches a log line, an error
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
  `/api/auth/**` at the edge; storage is in-memory unless both Upstash
  variables are set. No module-scope `setInterval` (`tests/guards/no-module-scope-timers.test.ts`):
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
  The edge middleware gates `/w/**` and `/api/w/**` on the JWT's `memberships`
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
  caller.
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
  in `src/lib/security/encrypted-fields.ts` (empty until Phase 1), never by
  calling the primitives: inside a workspace context a manifest field is a `v2:`
  envelope under the workspace's data key (`createWorkspaceWithDek` makes one
  per workspace, wrapped under `DATA_ENCRYPTION_KEY`). A field is encrypted only
  on the model that lists it (nested writes and includes resolve their model
  from the DMMF); every value is sealed, with no "already an envelope" skip;
  `runInWorkspaceContext` resolves the key before opening its transaction.
  Production refuses to
  start without `DATA_ENCRYPTION_KEY` and `AUTH_SECRET`; the web tier and the
  worker run an encrypt → decrypt sentinel at boot.
- **Audit trail.** Write through `logEvent(ctx, …)` (pass `{ db }` to commit
  with the change). Rows are hash-chained per workspace and append-only (a
  trigger refuses UPDATE, DELETE and TRUNCATE for every role); details carry
  ids, counts and codes, never author text or an email. Sign-in events are
  appended to each of the user's workspaces (`recordUserAuthEvent`).
- **Probes.** `/api/health` and `/api/livez` (process up) and `/api/readyz`
  (PostgreSQL and Redis within a 2 s timeout, 503 naming the failure) are
  unauthenticated and excluded from rate limiting.
- **Secrets.** `.husky/pre-commit` runs `scripts/detect-secrets.sh` on staged
  files; `tests/guards/no-secrets.test.ts` runs the same `.secret-patterns`
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
- **Integration** (`tests/integration`): a real PostgreSQL, never a mocked
  Prisma. `DATABASE_URL` from the shell wins; otherwise `jest.setup.js` uses
  `postgresql://postgres:postgres@localhost:5432/inkquisitor_test`. An
  integration test never skips because the database is missing: it fails.
- **Integration fixtures**: `tests/helpers/workspaces.ts` creates accounts
  through the real provisioning path, with unique emails; never clean
  `AuditLog` (it is append-only by trigger).
- **E2E** (`tests/e2e`): Playwright against a production build, against the
  database `DATABASE_URL` names (migrations applied). `playwright.config.ts`
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

## Implementation notes

Every subphase lands a note at
`docs/implementation-notes/<YYYY-MM-DD>-<subphase-id>-<slug>.md`: design, files,
decisions and trade-offs. No test counts — the test files are the record.
