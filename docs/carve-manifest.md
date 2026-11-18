# Carve manifest

Every file in Inkquisitor whose content is copied or adapted from
inflect-compliance is listed here (roadmap rule 7, owner decision D6). Both
works are licensed by Inflect Ltd. under BUSL-1.1; see `LICENSING.md`.

Source repository: `github.com/RodnaPamet/inflect-compliance`.

`tests/unit/carve-manifest.test.ts` checks that every Inkquisitor path in the
first table exists and that every row names a full 40-character source commit.
Phase 0.H audits the table against git the other way round (every file whose
content matches an inflect-compliance file must be listed).

## Copied or adapted files

| Inkquisitor path | Source path | Source commit | Edits made |
|---|---|---|---|
| `LICENSE` | `LICENSE` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Parameters block only: Licensed Work, Additional Use Grant and Change Date rewritten for Inkquisitor (owner decision D2). Header and Terms byte-identical, pinned by `tests/unit/licence.test.ts`. |
| `LICENSING.md` | `LICENSING.md` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Rewritten for Inkquisitor's grant and Change Date; added the section on code derived from inflect-compliance; third-party section points at `NOTICE`. |
| `NOTICE` | `NOTICE` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Layout only. Inflect's pipelock and OpenShell attributions are not carried (none of that material is in Inkquisitor); new derivation section and empty third-party headings. |
| `package.json` | `package.json` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Name, licence and engines kept in step; dependency set cut to what the skeleton uses, at inflect's versions; scripts rewritten; no workspaces, overrides, husky or semantic-release. |
| `.nvmrc` | `.nvmrc` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Verbatim. |
| `.gitignore` | `.gitignore` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Cut to the entries this tree produces; inflect-specific paths removed; the enumerated env-file lines replaced by `.env*` + `!.env.example` (the `.dockerignore` pattern), so `.env.development` and `.env.prod` are ignored too. |
| `.dockerignore` | `.dockerignore` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Removed inflect-specific re-includes (PII fixtures, staging/test/e2e env templates); removed the agent and tool directories (`.agents/`, `.gemini/`, the `.claude/` worktrees comment), `ARCHITECTURE.md`, `uploads/` and inflect's CI dump globs (`jest*.txt`, `jest*.json`, `err_*.txt`); added `jest.setup.*`; renamed the 'Temporary / CI artifacts' heading. |
| `tsconfig.json` | `tsconfig.json` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Dropped the `@inflect/ui` path, the `scripts`/`site`/`.next-test` exclusions and test-mode type includes. |
| `postcss.config.mjs` | `postcss.config.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | ESM; `autoprefixer` dropped (Tailwind 4 prefixes itself). |
| `eslint.config.mjs` | `eslint.config.mjs` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Kept the Next preset, `reportUnusedDisableDirectives` and the ignore list; added `eslint-config-next/typescript`; `any` and `no-console` are errors; the local rule plugin and every domain block left behind (Phase 0.4 lifts the generic rules). |
| `docker-compose.yml` | `docker-compose.yml` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Database renamed `inkquisitor`; comments that referred to inflect issues and docs rewritten; every published port bound to `127.0.0.1` (inflect publishes Postgres, PgBouncer and ClamAV on all interfaces). Services, images, port numbers and health checks unchanged. |
| `prisma/init-roles.sh` | `prisma/init-roles.sh` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Comments rewritten to name no inflect migration; SQL unchanged. |
| `Dockerfile` | `Dockerfile` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Same three stages and runner hardening (openssl floor, npm CLI removed, non-root user); schema copied before `npm ci` for the postinstall `prisma generate`; no workspace package, worker bundle, data directories or build-SHA argument. |
| `scripts/entrypoint.sh` | `scripts/entrypoint.sh` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Cut to step 1 (local `prisma migrate deploy`) and the final `exec next start`; every seed and sync step removed. |
| `prisma.config.ts` | `prisma.config.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Comments point at `src/lib/db.ts`; loads `.env` (the Prisma 7 CLI does not); `||` instead of `??` so an empty `DIRECT_DATABASE_URL` falls back to `DATABASE_URL`; the URL resolution is exported for its unit test. |
| `prisma/schema/base.prisma` | `prisma/schema/base.prisma` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Generator and datasource blocks unchanged; header rewritten (inflect's domain split removed). |
| `prisma/schema/README.md` | `prisma/schema/README.md` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Rewritten: one file today, the domain files later phases add. |
| `src/env.ts` | `src/env.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Same `createEnv` shape, `skipValidation` and `emptyStringAsUndefined`; two variables (`NODE_ENV`, `DATABASE_URL`) instead of ~90; no `zod-jitless` import yet (it exists for the CSP of Phase 0.H). |
| `src/env-client.ts` | `src/env-client.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Empty client schema; same `envClient`/`env` exports; no `zod-jitless` import yet. |
| `src/lib/db.ts` | `src/lib/prisma.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Only the adapter construction (`PrismaPg` + `PrismaClient`); no audit, soft-delete, encryption or RLS extensions (Phase 0.3). |
| `src/app/layout.tsx` | `src/app/layout.tsx` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | The `viewport` export; everything else is new (no intl, theme or CSP nonce yet). |
| `jest.config.js` | `jest.config.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Multi-project layout and the `@/env` / `@/env-client` → mock mapping kept; projects are `unit` and `integration`; no coverage, ESM allowlist or jsdom project. |
| `jest.setup.js` | `jest.setup.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Rewritten to three settings: `SKIP_ENV_VALIDATION`, the test database URL fallback, and no model key. |
| `tests/mocks/env.ts` | `tests/mocks/env.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Same Proxy over `process.env`; defaults cut to `NODE_ENV` (`'development'`, Inkquisitor's schema default); exports `envClient` too. |
| `tests/helpers/repo-files.ts` | `tests/helpers/repo-files.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header notes the lift; two inflect-specific measurements reworded; `prisma/generated/` dropped from the list of ignored trees (Inkquisitor does not ignore it); the `listGitFiles` comment names inflect's source-scan-population guardrail as the contract test still to come (Phase 0.4). Code unchanged. |
| `playwright.config.ts` | `playwright.config.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Cut to one Chromium project against `next start` on port 3100; no HTTP/2 proxy, global setup or tenant teardown. |

## Rules followed, code new

These files restate a rule or pattern from inflect-compliance in new code. No
text was copied; they are listed so the lineage is findable.

| Inkquisitor path | Rule or pattern from | Note |
|---|---|---|
| `tests/guards/client-modules-import-no-server-env.test.ts` | `tests/guards/client-reachable-modules-import-no-server-env.test.ts` | Direct imports only; the transitive import-graph walk comes with Phase 0.H. |
| `src/app/api/health/route.ts` | `src/app/api/livez/route.ts` | Liveness only, no dependency checks. |
| `next.config.mjs` | `Dockerfile` (the `--webpack` reasoning) | Build uses webpack for the CSP nonce, as inflect does. |
| `CLAUDE.md` | `CLAUDE.md` (implementation-note and testing conventions) | Written for Inkquisitor. |
| `.github/workflows/ci.yml` | `.github/workflows/ci.yml` (the concurrency group) | Pushes are grouped per commit (`github.sha`), as inflect's are, so a queued main run is never evicted; the rest is new. |
