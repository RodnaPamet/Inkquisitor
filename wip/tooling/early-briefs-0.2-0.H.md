# 0.2
Roadmap prompt (docs/ROADMAP.md, Phase 0.2) is the brief, plus:
- packages/ui becomes a workspace package @inkquisitor/ui (package.json workspaces ["packages/*"], tsconfig path @inkquisitor/ui/* like inflect's @inflect/ui/*). Rename every @inflect/ui import.
- Keep the primitives' own tests: port the relevant rendered tests from inflect-compliance tests/rendered and packages/ui tests where they exist, adapted; add a jest "rendered" project (jsdom) if needed.
- i18n: lift next-intl setup (src/i18n.ts, locale constants, cookie locale) with messages/en.json holding only the strings the lifted components use. English only for now.
- The app shell: a signed-out-safe AppShell with sidebar nav (Books, Settings placeholders), top chrome, theme toggle, and the command palette shell with no entity search yet. WorkspaceContext is a client context with a stub default value until 0.3 provides the real one.
- /dev/kitchen-sink renders every lifted primitive and is excluded from production builds (404 in production).
- Lift the ESLint/guard tests that protect these primitives only if they are generic (for example the token/colour discipline guards); skip compliance-specific ratchets.
Lenses: ui-integration (do the lifted components actually render: imports resolve, styles/tokens present, dark mode works, no hydration errors on /dev/kitchen-sink when built and started), bundle-and-client-boundary (no server-only modules imported from 'use client' files, no @/env in client code).

# 0.3
Roadmap prompt (Phase 0.3) is the brief, plus:
- Prisma schema files: prisma/schema/base.prisma (generator+datasource), enums.prisma, auth.prisma (User, Account, VerificationToken, UserSession, PasswordResetToken if reset is lifted), workspace.prisma (Workspace, WorkspaceMembership). Migrations in prisma/migrations created with prisma migrate (not db push), including the RLS SQL (app_user role, tenant_isolation-style policies named workspace_isolation, FORCE ROW LEVEL SECURITY, superuser bypass policy) the same way inflect-compliance does it.
- Routes: sign-up (credentials, HIBP check fail-open like inflect, password policy), sign-in page, sign-out, a /w/[workspaceSlug] app area guarded by middleware/proxy checking membership from the JWT, and getWorkspaceCtx() building a RequestContext (requestId, userId, workspaceId, role, permissions) threaded explicitly through usecases.
- Permissions: a small PermissionSet for OWNER/EDITOR/READER and requirePermission() for API routes, modelled on inflect-compliance's permission-middleware.
- Audit: an append-only AuditLog (hash-chained like inflect-compliance's audit writer, but simplified) written by logEvent() for sign-up, sign-in, membership changes. Keep it small.
- Integration tests run against a real Postgres (tests/integration, prismaTestClient + resetDatabase helpers like inflect's tests/helpers/db.ts) and CI's Test job runs them with the postgres service and migrations applied.
- Replace the 0.2 stub WorkspaceContext with the real provider.
Lenses: rls-isolation (can any path read or write another workspace's rows: app_user role really used at runtime, FORCE RLS on every workspace table, policies correct for INSERT and UPDATE WITH CHECK, bypass only where justified), auth-flows (sign-up/sign-in/sign-out, lockout, session revocation, JWT claims, middleware gate, open redirects, CSRF).

# 0.4
Roadmap prompt (Phase 0.4) is the brief, plus:
- CI: extend .github/workflows/ci.yml keeping the job names Lint, Typecheck, Test, Build, and adding Security (npm audit --omit=dev --audit-level=moderate, secret scan), CodeQL (github/codeql-action, javascript-typescript), and Docker (build the image, Trivy scan CRITICAL,HIGH). Add .github/workflows/release.yml (semantic-release on main) only if it can run without secrets beyond GITHUB_TOKEN; otherwise skip it and record why. Add a docs-site workflow that builds the Starlight site on PRs (deploy only on main, and only if Pages is configured; otherwise build-only).
- Husky pre-commit with the secret-detection script and .secret-patterns lifted from inflect-compliance.
- Health endpoints /api/livez and /api/readyz (db + redis) alongside /api/health.
- A scripts/worker.ts BullMQ worker entry with an empty executor registry, a no-op heartbeat job proving the wiring, and build:worker.
Lenses: ci-on-github (every new job will pass on a fresh runner; action versions pinned; permissions least-privilege; no secrets needed), ops-wiring (logger/OTel/Sentry init order, graceful shutdown, rate-limit tiers actually applied to routes, storage/mailer fail-safe defaults in dev).

# 0.H
Roadmap prompt (Phase 0.H) is the brief, plus: every verification is a test or a CI step, not a claim; anything that cannot be verified here is reported in notDone with what would verify it.
Lenses: adversarial-security (try to break auth, isolation, headers, CSP from the outside: list concrete attack attempts and their results), leftovers (grep for inflect vocabulary and dead code across the whole repo).
