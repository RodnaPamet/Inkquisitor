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
npm run lint              # eslint . (flat config, eslint.config.mjs)
npm run typecheck         # tsc --noEmit, then packages/ui alone (no `@/` imports there)
npm test                  # Jest, unit + rendered projects — no DB, no network
npm run test:integration  # Jest, integration project (tests/integration) — real PostgreSQL
npm run test:e2e          # Playwright against `next start` on :3100 (build first)
npm run db:generate       # prisma generate (also the postinstall step)
npm run db:migrate        # prisma migrate dev
docker compose up -d      # Postgres + pgvector, PgBouncer, Redis, ClamAV
```

Every one of `lint`, `typecheck`, `test`, `test:integration` and `build` must
pass before a change is finished. CI (`.github/workflows/ci.yml`) runs them as
the required checks **Lint**, **Typecheck**, **Test** and **Build**; the job
names are the check names, so never rename one.

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
src/lib/                → shared infrastructure (env, db, later auth, observability, storage, AI seam)
src/components/         → React components (ui/ primitives, layout/ shells, command-palette/, theme/)
packages/ui/            → @inkquisitor/ui, the workspace package of product-neutral primitives
messages/en.json        → next-intl catalogue (English only)
prisma/schema/          → multi-file Prisma schema; base.prisma owns the generator and datasource
```

A call goes `app/api → usecases → policies → repositories`, never sideways or
backwards: a route handler does not import a repository or Prisma, and a
repository does not authorize. Today only `src/app/api/health` and
`src/lib/{env,db,product}` exist; the `app-layer` folders arrive with the first
usecase (Phase 0.3).

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
  `prisma.config.ts`. Prisma 7 needs a driver adapter: construct clients
  through `src/lib/db.ts`. New models go in a domain file under
  `prisma/schema/`, never in `base.prisma`.
- **Logging.** No `console.*` under `src/` (ESLint error). The structured
  logger arrives in Phase 0.4; author text never reaches a log line.
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
  one context the chrome reads. Its exported interface is a contract with
  subphase 0.3 — do not change it. Shell components read
  `useOptionalWorkspace()` and render a signed-out state for `null`;
  `getCurrentWorkspace()` (`current-workspace.ts`) is the server-side stub 0.3
  replaces.
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
- **E2E** (`tests/e2e`): Playwright against a production build.
- **No test calls a model provider or any network service.** `jest.setup.js`
  clears `ANTHROPIC_API_KEY`.
- A guard that scans source takes its file population from git through
  `tests/helpers/repo-files.ts`, never a hand-written skip list.
- Write tests that fail when the behaviour regresses, not tests that pin the
  shape of a diff.

## Implementation notes

Every subphase lands a note at
`docs/implementation-notes/<YYYY-MM-DD>-<subphase-id>-<slug>.md`: design, files,
decisions and trade-offs. No test counts — the test files are the record.
