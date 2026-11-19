-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'EDITOR', 'READER');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "detailsJson" JSONB NOT NULL,
    "requestId" TEXT,
    "previousHash" TEXT,
    "entryHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "image" TEXT,
    "passwordHash" TEXT,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedDek" TEXT,
    "previousEncryptedDek" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMembership" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_sessionId_key" ON "UserSession"("sessionId");

-- CreateIndex
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_userId_idx" ON "WorkspaceMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMembership_workspaceId_userId_key" ON "WorkspaceMembership"("workspaceId", "userId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Phase 0.3 — row-level security, the app role, and the append-only audit trail
-- ═══════════════════════════════════════════════════════════════════
--
-- The pattern is inflect-compliance's (prisma/migrations/
-- 20260323180000_apply_full_rls_setup and 20260423150000_epic_d1_user_session_rls),
-- re-keyed from tenants to workspaces (owner decision D4):
--
--   app_user          NOLOGIN role. `runInWorkspaceContext`
--                     (src/lib/db/rls-middleware.ts) does
--                     `SET LOCAL ROLE app_user` and
--                     `set_config('app.workspace_id', …, true)` per
--                     transaction, so every policy below bites.
--   workspace_isolation  ONE policy per workspace-scoped table, USING and
--                     WITH CHECK on the same predicate: a row is visible,
--                     insertable and updatable only when its workspace is
--                     the transaction's. A single policy (not inflect's
--                     separate `_insert` sibling) leaves no permissive
--                     neighbour to OR a write through.
--   superuser_bypass  Every other role — the owner running migrations, the
--                     sign-up and sign-in paths on the global client — sees
--                     all rows. It fires only when the role has NOT been
--                     switched to app_user.
--   FORCE             Makes the table owner subject to RLS too, so the
--                     bypass is the policy above and nothing implicit.
--
-- A superuser (CI's and the local `postgres`) skips RLS whatever FORCE
-- says; that is why the context switches ROLE rather than relying on FORCE.
-- tests/integration/rls-coverage.test.ts reads pg_class / pg_policies and
-- fails for a workspace-scoped table missing any of this.

-- ─── 1) The app role ──────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
-- The migration ledger is not the application's to touch. Guarded: the
-- shadow database `prisma migrate dev` replays this into has no ledger.
DO $$
BEGIN
    IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
        REVOKE ALL ON TABLE "_prisma_migrations" FROM app_user;
    END IF;
END
$$;

-- The identity tables a workspace context never needs. Sign-in, the session
-- check and Google account linking read them on the plain client
-- (`src/lib/auth/**`, `src/lib/security/session-tracker.ts`); app_user, which
-- every workspace transaction runs as, cannot read a password-reset-style
-- token, another person's linked identity or another person's session rows.
-- `User` stays readable: a member list names its members.
REVOKE ALL ON TABLE "Account", "UserSession", "VerificationToken" FROM app_user;

-- `SET ROLE app_user` needs membership for a non-superuser owner; a
-- superuser has it implicitly. Granted to whoever runs the migration.
DO $$
BEGIN
    EXECUTE format('GRANT app_user TO %I', current_user);
EXCEPTION WHEN others THEN
    RAISE NOTICE 'GRANT app_user TO % skipped: %', current_user, SQLERRM;
END
$$;

-- ─── 2) Workspace: scoped on its own id ──────────────────────────────

ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "Workspace";
CREATE POLICY workspace_isolation ON "Workspace"
    USING ("id" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("id" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "Workspace";
CREATE POLICY superuser_bypass ON "Workspace"
    USING (current_setting('role') != 'app_user');

-- A rotation that wrote the same wrapped key into both slots would make the
-- "previous" fallback meaningless (inflect's tenant twin of this CHECK).
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_previousEncryptedDek_differs"
    CHECK ("previousEncryptedDek" IS NULL OR "previousEncryptedDek" <> "encryptedDek");

-- ─── 3) WorkspaceMembership ──────────────────────────────────────────

ALTER TABLE "WorkspaceMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMembership" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "WorkspaceMembership";
CREATE POLICY workspace_isolation ON "WorkspaceMembership"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "WorkspaceMembership";
CREATE POLICY superuser_bypass ON "WorkspaceMembership"
    USING (current_setting('role') != 'app_user');

-- ─── 4) AuditLog: scoped, and append-only for every role ─────────────

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "AuditLog";
CREATE POLICY workspace_isolation ON "AuditLog"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AuditLog";
CREATE POLICY superuser_bypass ON "AuditLog"
    USING (current_setting('role') != 'app_user');

-- The app role may read and append, nothing else.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM app_user;

-- And no role may rewrite history: the trigger fires for the owner and a
-- superuser too. Changing the trail means dropping this trigger in a
-- reviewed migration, which is the point.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'AuditLog is append-only: % refused', TG_OP
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON "AuditLog";
CREATE TRIGGER audit_log_no_update_delete
    BEFORE UPDATE OR DELETE ON "AuditLog"
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON "AuditLog";
CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON "AuditLog"
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
