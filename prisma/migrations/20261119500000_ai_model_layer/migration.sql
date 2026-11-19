-- Phase 2.1 — the model layer's ledger: AiCallLog (one row per model call,
-- append-only), AiSpendMonth (a workspace's settled spend per UTC month) and
-- AiSpendReservation (a running call's worst case, held against the
-- ceiling). The enums, CREATE TABLEs, indexes and foreign keys are what
-- `prisma migrate diff` generates from prisma/schema/ai.prisma and
-- enums.prisma; the CHECK constraints, the row-level security, the grants
-- and the append-only trigger are appended by hand.
--
-- NUMBERS AND NAMES, NEVER TEXT (roadmap rule 4). No column here holds a
-- prompt, author text, a model's answer or a provider message. Every string
-- column is code-supplied, and the CHECKs below bound each one's shape, so a
-- sentence cannot land in one by mistake: a purpose, a prompt id, a version, a
-- model id, an output mode, an error code from the closed list and guard rule
-- ids.
--
-- Written only by src/app-layer/repositories/ai-call.repository.ts, inside
-- runInWorkspaceContext (app_user, the workspace's RLS). The spend ceiling's
-- concurrency rests on a transaction-scoped advisory lock per workspace
-- (`hashtext('ai-spend:' || workspaceId)`) that every reservation and every
-- settlement takes first; see that repository.
-- CreateEnum
CREATE TYPE "AiCallOutcome" AS ENUM ('OK', 'REPAIRED', 'INVALID_OUTPUT', 'REFUSED_GUARD', 'CEILING', 'KILLED', 'PROVIDER_ERROR', 'TIMEOUT', 'ABORTED');

-- CreateEnum
CREATE TYPE "AiModelTier" AS ENUM ('FAST', 'BALANCED', 'DEEP');

-- CreateTable
CREATE TABLE "AiCallLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT,
    "requestedById" TEXT,
    "purpose" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "tier" "AiModelTier" NOT NULL,
    "model" TEXT NOT NULL,
    "outputMode" TEXT,
    "attempts" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL,
    "costMicroUsd" INTEGER NOT NULL,
    "costEstimated" BOOLEAN NOT NULL,
    "worstCaseMicroUsd" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "outcome" "AiCallOutcome" NOT NULL,
    "errorCode" TEXT,
    "guardRuleIds" TEXT[],
    "guardReviewRequired" BOOLEAN NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSpendMonth" (
    "workspaceId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "spentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSpendMonth_pkey" PRIMARY KEY ("workspaceId","periodStart")
);

-- CreateTable
CREATE TABLE "AiSpendReservation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "amountMicroUsd" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSpendReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCallLog_workspaceId_startedAt_idx" ON "AiCallLog"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "AiCallLog_workspaceId_bookId_idx" ON "AiCallLog"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "AiCallLog_requestedById_idx" ON "AiCallLog"("requestedById");

-- CreateIndex
CREATE INDEX "AiSpendReservation_workspaceId_periodStart_expiresAt_idx" ON "AiSpendReservation"("workspaceId", "periodStart", "expiresAt");

-- AddForeignKey
ALTER TABLE "AiCallLog" ADD CONSTRAINT "AiCallLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallLog" ADD CONSTRAINT "AiCallLog_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallLog" ADD CONSTRAINT "AiCallLog_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSpendMonth" ADD CONSTRAINT "AiSpendMonth_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSpendReservation" ADD CONSTRAINT "AiSpendReservation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- CHECK constraints: no free text, no negative counts
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "AiCallLog"
    ADD CONSTRAINT "AiCallLog_purpose_shape" CHECK ("purpose" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
    ADD CONSTRAINT "AiCallLog_promptId_shape" CHECK ("promptId" ~ '^[a-z][a-z0-9_.-]{0,63}$'),
    ADD CONSTRAINT "AiCallLog_promptVersion_shape" CHECK ("promptVersion" ~ '^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$'),
    ADD CONSTRAINT "AiCallLog_model_shape" CHECK ("model" ~ '^[a-z0-9][a-z0-9.-]{1,99}$'),
    ADD CONSTRAINT "AiCallLog_outputMode_known" CHECK ("outputMode" IS NULL OR "outputMode" IN ('json_schema', 'single_tool')),
    ADD CONSTRAINT "AiCallLog_attempts_range" CHECK ("attempts" BETWEEN 0 AND 2),
    ADD CONSTRAINT "AiCallLog_counts_nonnegative" CHECK (
        "inputTokens" >= 0 AND "outputTokens" >= 0 AND "cacheReadTokens" >= 0 AND "cacheWriteTokens" >= 0
        AND "costMicroUsd" >= 0 AND "worstCaseMicroUsd" >= 0 AND "durationMs" >= 0
    ),
    -- AI_ERROR_CODES in src/lib/ai/errors.ts; a new code widens this list in a migration.
    ADD CONSTRAINT "AiCallLog_errorCode_known" CHECK ("errorCode" IS NULL OR "errorCode" IN (
        'AI_DISABLED', 'CREDENTIAL_NOT_CONFIGURED', 'SDK_AMBIENT_HEADERS_SET', 'ZDR_NOT_CONFIRMED',
        'PROVIDER_HTTP_ERROR', 'PROVIDER_CONNECTION', 'REQUEST_REFUSED', 'MODEL_REFUSED', 'INTERNAL_ERROR',
        'INVALID_AFTER_REPAIR', 'TRUNCATED', 'NO_OUTPUT',
        'GUARD_BLOCKED_INPUT', 'GUARD_BLOCKED_OUTPUT', 'GUARD_UNAVAILABLE',
        'SPEND_CEILING', 'DEADLINE', 'CALLER_ABORT'
    )),
    ADD CONSTRAINT "AiCallLog_errorCode_iff_not_ok" CHECK (("outcome" IN ('OK', 'REPAIRED')) = ("errorCode" IS NULL)),
    -- Rule ids are lower-case dotted names (`inj.ignore_previous.instructions`).
    ADD CONSTRAINT "AiCallLog_guardRuleIds_shape" CHECK (
        cardinality("guardRuleIds") <= 64
        AND array_to_string("guardRuleIds", ',') ~ '^([a-z0-9_.]{1,80}(,[a-z0-9_.]{1,80})*)?$'
    );

ALTER TABLE "AiSpendMonth"
    ADD CONSTRAINT "AiSpendMonth_spent_nonnegative" CHECK ("spentMicroUsd" >= 0),
    ADD CONSTRAINT "AiSpendMonth_period_first_day" CHECK (extract(day FROM "periodStart") = 1);

ALTER TABLE "AiSpendReservation"
    ADD CONSTRAINT "AiSpendReservation_amount_nonnegative" CHECK ("amountMicroUsd" >= 0),
    ADD CONSTRAINT "AiSpendReservation_period_first_day" CHECK (extract(day FROM "periodStart") = 1);

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the set every workspace-scoped table carries
-- ═══════════════════════════════════════════════════════════════════
--
-- RLS enabled and FORCED, ONE `workspace_isolation` policy with USING and
-- WITH CHECK on the same predicate, and `superuser_bypass` for every role but
-- app_user (docs/rls-workspace-isolation.md). tests/guards/rls-migration-coverage.test.ts
-- compares these statements exactly; tests/integration/rls-coverage.test.ts
-- compares what PostgreSQL stored and proves they isolate.
--
-- Grants: app_user reads and inserts call records and nothing else (the
-- append-only trigger below refuses UPDATE and DELETE for every role besides);
-- it reads, inserts and updates a month's spend; and it reads, inserts,
-- updates (a repair re-reserves) and deletes reservations.

REVOKE ALL ON "AiCallLog" FROM app_user;
GRANT SELECT, INSERT ON "AiCallLog" TO app_user;
REVOKE ALL ON "AiSpendMonth" FROM app_user;
GRANT SELECT, INSERT, UPDATE ON "AiSpendMonth" TO app_user;
REVOKE ALL ON "AiSpendReservation" FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "AiSpendReservation" TO app_user;

ALTER TABLE "AiCallLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiCallLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "AiCallLog";
CREATE POLICY workspace_isolation ON "AiCallLog"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AiCallLog";
CREATE POLICY superuser_bypass ON "AiCallLog"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "AiSpendMonth" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiSpendMonth" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "AiSpendMonth";
CREATE POLICY workspace_isolation ON "AiSpendMonth"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AiSpendMonth";
CREATE POLICY superuser_bypass ON "AiSpendMonth"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "AiSpendReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiSpendReservation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "AiSpendReservation";
CREATE POLICY workspace_isolation ON "AiSpendReservation"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AiSpendReservation";
CREATE POLICY superuser_bypass ON "AiSpendReservation"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- AiCallLog is append-only
-- ═══════════════════════════════════════════════════════════════════
--
-- The call record is the evidence of what was sent where and what it cost.
-- Nothing rewrites it: the trigger refuses UPDATE and DELETE (P0001, message
-- prefix AI_CALL_LOG_APPEND_ONLY) and TRUNCATE, for every role, the owner and
-- a superuser included, as the audit log's and the bible history's do.
--
-- Three writes pass, each made by the database's own referential actions:
--
--   * The DELETE its workspace's cascade makes: by the time the trigger runs
--     for those rows the workspace row is already gone, which is what the
--     check reads.
--   * The DELETE its book's cascade makes (the book's purge, 30 days after the
--     author deleted it): the book row is gone. A call record of a book that
--     still exists is never deleted. The month's spend is NOT kept here, so a
--     purge never lowers what the ceiling counts (AiSpendMonth).
--   * The UPDATE that clears `requestedById` when that person's account is
--     deleted (ON DELETE SET NULL): only that column changes, from a user who
--     no longer exists to NULL.
--
-- Referential actions run as the table's owner, so the cascades need no grant
-- app_user lacks. Keep the function VOLATILE: each check reads a fresh snapshot.

CREATE OR REPLACE FUNCTION ai_call_log_append_only() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = OLD."workspaceId") THEN
            RETURN OLD;
        END IF;
        IF OLD."bookId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Book" WHERE "id" = OLD."bookId") THEN
            RETURN OLD;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD."requestedById" IS NOT NULL
           AND NEW."requestedById" IS NULL
           AND (to_jsonb(NEW) - 'requestedById') = (to_jsonb(OLD) - 'requestedById')
           AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."requestedById") THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'AI_CALL_LOG_APPEND_ONLY: % of AiCallLog refused', TG_OP
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS ai_call_log_no_update_delete ON "AiCallLog";
CREATE TRIGGER ai_call_log_no_update_delete
    BEFORE UPDATE OR DELETE ON "AiCallLog"
    FOR EACH ROW EXECUTE FUNCTION ai_call_log_append_only();

DROP TRIGGER IF EXISTS ai_call_log_no_truncate ON "AiCallLog";
CREATE TRIGGER ai_call_log_no_truncate
    BEFORE TRUNCATE ON "AiCallLog"
    FOR EACH STATEMENT EXECUTE FUNCTION ai_call_log_append_only();
