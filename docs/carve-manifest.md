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
| `package.json` | `package.json` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Name, licence and engines kept in step; dependency set cut to what the skeleton uses, at inflect's versions; scripts rewritten; no workspaces, overrides or semantic-release. Phase 0.4 adds the platform-service dependencies at inflect's ranges (pino, OpenTelemetry, Sentry, Upstash, AWS S3, nodemailer, BullMQ, ioredis; esbuild, husky, tsx, pino-pretty), `build:worker`, `worker`, `prepare` (husky) and `secret-scan`. |
| `.nvmrc` | `.nvmrc` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Verbatim. |
| `.gitignore` | `.gitignore` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Cut to the entries this tree produces; inflect-specific paths removed. Phase 0.4 adds the docs site's generated paths. |
| `.dockerignore` | `.dockerignore` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Removed inflect-specific re-includes (PII fixtures, staging/test/e2e env templates). Phase 0.4 excludes `site/`, `dist/` and `.husky/`. |
| `tsconfig.json` | `tsconfig.json` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Dropped the `@inflect/ui` path, the `scripts`/`site`/`.next-test` exclusions and test-mode type includes. |
| `postcss.config.mjs` | `postcss.config.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | ESM; `autoprefixer` dropped (Tailwind 4 prefixes itself). |
| `eslint.config.mjs` | `eslint.config.mjs` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Kept the Next preset, `reportUnusedDisableDirectives` and the ignore list; added `eslint-config-next/typescript`; `any` and `no-console` are errors; Phase 0.4 registers the local rule plugin (five generic rules) with their scopes; every domain block left behind. |
| `docker-compose.yml` | `docker-compose.yml` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Database renamed `inkquisitor`; comments that referred to inflect issues and docs rewritten. Services, images, ports and health checks unchanged. |
| `prisma/init-roles.sh` | `prisma/init-roles.sh` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Comments rewritten to name no inflect migration; SQL unchanged. |
| `Dockerfile` | `Dockerfile` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Same three stages and runner hardening (openssl floor, npm CLI removed, non-root user); schema copied before `npm ci` for the postinstall `prisma generate`; no workspace package, data directories or build-SHA argument. Phase 0.4 builds the worker bundle into `dist/` and sets `HUSKY=0` for the install. |
| `scripts/entrypoint.sh` | `scripts/entrypoint.sh` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Cut to step 1 (local `prisma migrate deploy`) and the final `exec next start`; every seed and sync step removed. |
| `prisma.config.ts` | `prisma.config.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Comments point at `src/lib/db.ts`. |
| `prisma/schema/base.prisma` | `prisma/schema/base.prisma` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Generator and datasource blocks unchanged; header rewritten (inflect's domain split removed). |
| `prisma/schema/README.md` | `prisma/schema/README.md` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Rewritten: one file today, the domain files later phases add. |
| `src/env.ts` | `src/env.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Same `createEnv` shape, `skipValidation` and `emptyStringAsUndefined`; the variables this repository reads instead of ~90; no `zod-jitless` import yet (it exists for the CSP of Phase 0.H). Phase 0.4 adds the platform-service variables, all optional, and inflect's production REDIS_URL rule. |
| `src/env-client.ts` | `src/env-client.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Empty client schema; same `envClient`/`env` exports; no `zod-jitless` import yet. |
| `src/lib/db.ts` | `src/lib/prisma.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Only the adapter construction (`PrismaPg` + `PrismaClient`); no audit, soft-delete, encryption or RLS extensions (Phase 0.3). |
| `src/app/layout.tsx` | `src/app/layout.tsx` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | The `viewport` export; everything else is new (no intl, theme or CSP nonce yet). |
| `jest.config.js` | `jest.config.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Multi-project layout and the `@/env` / `@/env-client` → mock mapping kept; projects are `unit` and `integration`; no coverage, ESM allowlist or jsdom project. The unit project also runs `eslint-rules/__tests__`. |
| `jest.setup.js` | `jest.setup.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Rewritten to four settings: `SKIP_ENV_VALIDATION`, the test database URL fallback, no model key, and silent logs. |
| `tests/mocks/env.ts` | `tests/mocks/env.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Same Proxy over `process.env`; defaults cut to `NODE_ENV`; exports `envClient` too. |
| `tests/helpers/repo-files.ts` | `tests/helpers/repo-files.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header notes the lift; two inflect-specific measurements reworded. Code unchanged. |
| `playwright.config.ts` | `playwright.config.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Cut to one Chromium project against `next start` on port 3100; no HTTP/2 proxy, global setup or tenant teardown. Phase 0.4 passes the production-required values to `next start`. |
| `src/lib/observability/logger.ts` | `src/lib/observability/logger.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Redaction list moved to `redaction.ts` and extended with author-text names (rule 4); tenant → workspace bindings; `loggerOptions` / `createLogger(destination)` exported as the test seam; level from `env`. |
| `src/lib/observability/redaction.ts` | `src/lib/observability/logger.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | The `REDACT_PATHS` list, split out and extended (text, answer, content, body and plurals); pino paths generated at three depths; `redactFields` added for the edge logger. |
| `src/lib/observability/context.ts` | `src/lib/observability/context.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | `tenantId` → `workspaceId`; comments rewritten. |
| `src/lib/observability/edge-logger.ts` | `src/lib/observability/edge-logger.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Fields pass through `redactFields`; `formatEdgeLine` exported for tests. |
| `src/lib/observability/tracing.ts` | `src/lib/observability/tracing.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Tracer renamed; context attributes are workspace-optional; one shared span helper. |
| `src/lib/observability/metrics.ts` | `src/lib/observability/metrics.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Cut to the request and job instruments; route normaliser collapses `/w/<slug>/`. |
| `src/lib/observability/sentry.ts` | `src/lib/observability/sentry.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | `beforeSend` exported as `scrubEvent`; cookies and case-insensitive auth headers dropped too; `captureError` sends ids only and is a no-op without a client; flush/diagnostic helpers not carried. |
| `src/lib/observability/instrumentation.ts` | `src/lib/observability/instrumentation.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Reads `env`; observable-gauge rebind registry not carried. |
| `src/lib/observability/shutdown.ts` | `src/lib/observability/shutdown.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Stages are data (`runShutdownStages`, test seam); audit-stream and agentic-run stages replaced by closing the queue and Redis connections; on a signal it defers `next start`'s `process.exit` until the stages have run, with a fallback timer (`installShutdownHandlers` takes a host seam). |
| `src/lib/observability/shutdown-budget.ts` | `src/lib/observability/shutdown-budget.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Three stages (connections, OTel, Sentry) under an 8 s ceiling. |
| `src/lib/observability/job-trace.ts` | `src/lib/observability/job-trace.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Tracer renamed; comments cut. |
| `src/lib/observability/job-runner.ts` | `src/lib/observability/job-runner.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | `tenantId` → `workspaceId`; job metrics recorded once, by the registry. |
| `src/lib/observability/process-logger.ts` | `src/lib/observability/process-logger.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Shares `loggerOptions()` (same redaction as the web logger); worker only. |
| `src/lib/observability/index.ts` | `src/lib/observability/index.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Barrel cut to the modules carried. |
| `src/instrumentation-node.ts` | `src/instrumentation.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Production config check, OTel, Sentry, mailer, shutdown handlers; compliance bootstraps removed. |
| `src/lib/errors/types.ts` | `src/lib/errors/types.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Domain codes cut to the product-neutral ones; `tenantIsolationViolation` → `workspaceIsolationViolation`. |
| `src/lib/errors/api.ts` | `src/lib/errors/api.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | API-version header and params-typing shim removed; request id accepted only in a safe shape; tenant/user Sentry args dropped. |
| `src/lib/security/rate-limit.ts` | `src/lib/security/rate-limit.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Presets cut to LOGIN, API_MUTATION, API_READ, EMAIL_DISPATCH and the progressive login policy; JSDoc no longer names `/api/docs`, API keys, SSO or MFA. |
| `src/lib/security/rate-limit-middleware.ts` | `src/lib/security/rate-limit-middleware.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Per-API-key budget removed; bypass reads `env` and drops the AUTH_TEST_MODE / NEXT_TEST_MODE hatches. |
| `src/lib/rate-limit/authRateLimit.ts` | `src/lib/rate-limit/authRateLimit.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Storage moved to `window-store.ts`; register / password-reset paths added to the high tier; error envelope shape. |
| `src/lib/rate-limit/apiReadRateLimit.ts` | `src/lib/rate-limit/apiReadRateLimit.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Every `/api/` GET (not only tenant routes), keyed on workspace; `/api/auth` excluded; `/api/docs` (an inflect route not carried) no longer exempt; storage moved to `window-store.ts`. |
| `src/lib/rate-limit/window-store.ts` | `src/lib/rate-limit/authRateLimit.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | The memory window and Upstash limiter both edge tiers used, extracted; Upstash only when both REST variables are set; lazy sweep added. |
| `src/middleware.ts` | `src/middleware.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Cut to the auth and read tiers and the request id; no session or tenant gate (Phase 0.3). |
| `src/lib/storage/types.ts` | `src/lib/storage/types.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Verbatim apart from the header. |
| `src/lib/storage/index.ts` | `src/lib/storage/index.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Tenant → workspace keys and guard; Inkquisitor domains and MIME list; default provider `local`; legacy helpers dropped. |
| `src/lib/storage/local-provider.ts` | `src/lib/storage/local-provider.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Root is FILE_STORAGE_ROOT (OS-temp default), read per call; unused options removed. |
| `src/lib/storage/s3-provider.ts` | `src/lib/storage/s3-provider.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header; the floating IIFE made explicit with `void`; download URLs default to and are capped at `SIGNED_DOWNLOAD_URL_TTL_SECONDS`, upload targets read `SIGNED_UPLOAD_URL_TTL_SECONDS`. |
| `src/lib/storage/av-scan.ts` | `src/lib/storage/av-scan.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | `scanMode()` defaults to strict; error logged as a message; references to the AV webhook (not carried) removed from the comments. |
| `src/lib/storage/signed-url-policy.ts` | `src/lib/storage/signed-url-policy.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Comment rewritten: the S3 provider is the reader (inflect's readers, the download route and evidence usecase, are not carried); `SIGNED_UPLOAD_URL_TTL_SECONDS` and `clampDownloadTtl` added. |
| `src/lib/http/content-disposition.ts` | `src/lib/http/content-disposition.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header shortened. |
| `src/lib/http/public-base-url.ts` | `src/lib/http/public-base-url.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header rewritten; logger import narrowed. |
| `src/lib/mailer.ts` | `src/lib/mailer.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Console sink logs counts and recipient domains only (no body preview); SMTP from `env`; BCC and system-user check dropped; TLS required (`smtpTransportOptions`). |
| `src/lib/redis.ts` | `src/lib/redis.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Development default URL, production throw; eviction probe not carried; `createProducerRedisClient` (no offline queue) added for the queue. |
| `src/lib/health/readiness.ts` | `src/app/api/readyz/route.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | The checks as data with a fixed error vocabulary; S3 check not carried; zero checks is not ready. |
| `src/app/api/readyz/route.ts` | `src/app/api/readyz/route.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Thin route over `readiness.ts`. |
| `src/app/api/livez/route.ts` | `src/app/api/livez/route.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Plain `Response.json`. |
| `src/app-layer/jobs/types.ts` | `src/app-layer/jobs/types.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | One job (`heartbeat`); queue renamed `inkquisitor-jobs`. |
| `src/app-layer/jobs/queue.ts` | `src/app-layer/jobs/queue.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Queue per name (test seam); job-id check inlined; carrier via `captureTraceCarrier`; producer connection fails fast and the add is bounded by `ENQUEUE_TIMEOUT_MS`. |
| `src/app-layer/jobs/executor-registry.ts` | `src/app-layer/jobs/executor-registry.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Emptied of compliance jobs; one no-op `heartbeat` registration; integration retry-bypass not carried. |
| `src/app-layer/jobs/scheduler.ts` | `src/app-layer/jobs/scheduler.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header and examples rewritten; logic verbatim. |
| `src/app-layer/jobs/schedules.ts` | `src/app-layer/jobs/schedules.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | One schedule (`heartbeat`, every 2 minutes). |
| `src/app-layer/jobs/register-schedules.ts` | `src/app-layer/jobs/register-schedules.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Retired-scheduler sweep not carried. |
| `src/app-layer/jobs/heartbeat.ts` | `src/app-layer/jobs/worker-heartbeat.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Key renamed; `isWorkerHealthy` added. |
| `src/app-layer/jobs/worker.ts` | `scripts/worker.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | The processor as a function (`createJobWorker`); payload never logged. |
| `scripts/worker.ts` | `scripts/worker.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Bootstrap and shutdown only; production config check; queue-depth gauge, agentic-run pause and compliance bootstraps not carried. |
| `scripts/worker-healthcheck.ts` | `scripts/worker-healthcheck.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Reads `isWorkerHealthy`. |
| `scripts/build-worker.mjs` | `scripts/build-worker.mjs` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Two entry points (worker, healthcheck); target node24. |
| `scripts/detect-secrets.sh` | `scripts/detect-secrets.sh` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Paths of the tests renamed; site build output skipped; run-mode and path-shape comments rewritten for this repo (no lint-staged, `--all` from CI's Security job). |
| `.secret-patterns` | `.secret-patterns` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header paths renamed; patterns verbatim. |
| `.husky/pre-commit` | `.husky/pre-commit` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | The secret scan only (no lint-staged). |
| `tests/guards/no-secrets.test.ts` | `tests/guardrails/no-secrets.test.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Population from `repoRelativeFiles()`; site skips; workspace paths in the anchoring cases. |
| `tests/unit/detect-secrets.test.ts` | `tests/unit/security/detect-secrets.test.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Paths adjusted; lint-staged references reworded as inflect history. |
| `tests/helpers/binary-extensions.ts` | `tests/helpers/binary-extensions.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header's consumer list corrected to this repo's `tests/guards/no-secrets.test.ts` (the control-byte guard it named is not carried). |
| `tests/helpers/source-blocks.ts` | `tests/helpers/source-blocks.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Verbatim apart from the header, which labels the cited guard files as inflect-compliance history and repoints the CLAUDE.md reference to this repo's Testing section. |
| `tests/unit/source-blocks-helpers.test.ts` | `tests/unit/source-blocks-helpers.test.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Two disable comments for an uncarried rule removed. |
| `eslint-rules/index.js` | `eslint-rules/index.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Five rules registered. |
| `eslint-rules/README.md` | `eslint-rules/README.md` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Rewritten for the five rules. |
| `eslint-rules/rules/anthropic-client-single-seam.js` | `eslint-rules/rules/anthropic-client-single-seam.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Seam is `src/lib/ai/client.ts`; messages reworded. |
| `eslint-rules/rules/no-raw-prompt-logging.js` | `eslint-rules/rules/no-raw-prompt-logging.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header rewritten for rule 4 (the companion census guard is not carried, and the header says nothing counts holes yet); compliance sinks replaced by `captureError`; author-text tokens added; messages reworded. |
| `eslint-rules/rules/no-request-derived-public-url.js` | `eslint-rules/rules/no-request-derived-public-url.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Header rewritten. |
| `eslint-rules/rules/no-brand-focus-indicator.js` | `eslint-rules/rules/no-brand-focus-indicator.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | WHY section and message rewritten without the host examples. |
| `eslint-rules/rules/no-translucent-focus-indicator.js` | `eslint-rules/rules/no-translucent-focus-indicator.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | WHY section and message shortened. |
| `eslint-rules/__tests__/anthropic-client-single-seam.test.ts` | `eslint-rules/__tests__/anthropic-client-single-seam.test.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Seam path in one valid case. |
| `eslint-rules/__tests__/anthropic-client-single-seam.config.test.ts` | `eslint-rules/__tests__/anthropic-client-single-seam.config.test.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Seam is `src/lib/ai/client.ts` (planted: the file arrives in Phase 2.1); plant sites are this repo's; the child-process runner moved to a helper. |
| `eslint-rules/__tests__/helpers/lint-with-repo-config.ts` | `eslint-rules/__tests__/anthropic-client-single-seam.config.test.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | The child-process ESLint runner, extracted so `no-raw-prompt-logging.config.test.ts` shares it; no `projectService` override (no type-aware rule here). |
| `eslint-rules/__tests__/no-raw-prompt-logging.test.ts` | `eslint-rules/__tests__/no-raw-prompt-logging.test.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Audit sink is `logEvent`; author-text cases added. |
| `eslint-rules/__tests__/no-brand-focus-indicator.test.ts` | `eslint-rules/__tests__/no-brand-focus-indicator.test.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Verbatim. |
| `eslint-rules/__tests__/no-translucent-focus-indicator.test.ts` | `eslint-rules/__tests__/no-translucent-focus-indicator.test.ts` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Verbatim. |
| `.github/workflows/release.yml` | `.github/workflows/release.yml` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Rewritten to need GITHUB_TOKEN only: no git/changelog plugins, no App token, no comments; semantic-release installed with `npm ci` from `release/package-lock.json`, checkout without persisted credentials. |
| `.github/workflows/docs-site.yml` | `.github/workflows/docs-site.yml` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | One site, no reference generator; same Pages guard. |
| `site/package.json` | `site/package.json` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | One site; same Astro and Starlight versions. |
| `site/astro.config.mjs` | `site/scripts/astro-site.mjs` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | One help site at `/Inkquisitor/`. |
| `site/src/content.config.mjs` | `site/users/src/content.config.mjs` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Verbatim. |
| `site/scripts/stage-docs.js` | `site/scripts/stage-docs.js` | `5528464fc54a8681956f3b9ce23ca9c075f0420e` | Rewritten for one site publishing `docs/user/` only; NEVER_PUBLISH lists the internal docs; no UI tokens, routes or generated pages; entries must be plain normalised paths, symbolic links are never read and output paths stay under the content folder. |

## Rules followed, code new

These files restate a rule or pattern from inflect-compliance in new code. No
text was copied; they are listed so the lineage is findable.

| Inkquisitor path | Rule or pattern from | Note |
|---|---|---|
| `tests/guards/client-modules-import-no-server-env.test.ts` | `tests/guards/client-reachable-modules-import-no-server-env.test.ts` | Direct imports only; the transitive import-graph walk comes with Phase 0.H. |
| `src/app/api/health/route.ts` | `src/app/api/livez/route.ts` | Liveness only, no dependency checks. |
| `src/instrumentation.ts` | Next's instrumentation docs; inflect-compliance `src/instrumentation.ts` | The `=== 'nodejs'` dynamic-import split, so the edge compile never bundles BullMQ. |
| `src/lib/startup-checks.ts` | `src/lib/security/startup-encryption-check.ts`, `src/instrumentation.ts` (GAP-13) | A pure list of what production refuses to start without, asked by the web and worker processes. |
| `src/app-layer/types.ts` | `src/app-layer/types.ts` (`RequestContext`) | New shape: workspace fields optional until Phase 0.3. |
| `scripts/sarif-gate.js` | `scripts/sast-alert-gate.mjs` (#4047) | Gates the CodeQL check on the SARIF the job wrote, rather than on code scanning's alert comparison, which needs code scanning enabled. |
| `eslint-rules/__tests__/no-raw-prompt-logging.config.test.ts` | `eslint-rules/__tests__/anthropic-client-single-seam.config.test.ts` | Same shape for the author-text rule's scope. |
| `eslint-rules/__tests__/no-request-derived-public-url.test.ts` | `tests/guards/eslint-local-rules-wired.test.ts` | inflect had no RuleTester for this rule; written new. |
| `.github/workflows/ci.yml` | `.github/workflows/ci.yml` | Phase 0.4 jobs Security, CodeQL and Docker: the gates (`npm audit --omit=dev --audit-level=moderate`, CodeQL javascript-typescript, Trivy CRITICAL,HIGH) at inflect's strictness; job bodies written new. |
| `.releaserc.json` | `.releaserc.json` | Three plugins only, so the release needs GITHUB_TOKEN alone. |
| `next.config.mjs` | `Dockerfile` (the `--webpack` reasoning), `next.config.js` (`serverExternalPackages`) | Build uses webpack for the CSP nonce, as inflect does; Phase 0.4 externalises inflect's list of Node-loaded packages. |
| `CLAUDE.md` | `CLAUDE.md` (implementation-note and testing conventions) | Written for Inkquisitor. |
