-- Phase 4.3 — book-level interrogation (decision D29).
--
--   StressTest / StressWeakPoint   a deep-tier pass over the canon, on demand, its weak points as questions
--                                  (never verdicts or rewrites), each citing the rows it rests on by id
--   GapHunt                        the code's candidate gaps, ranked by one cheap model call (or shown
--                                  unranked, with the reason), and the next three sessions
--   InterviewCompaction            a long session's summary of its earlier rounds' questions
--   InterviewSession.stressTestId  an interview started from a stress test's weak points
--   persona CHECKs                 the three book-level panel personas join the closed list
--
-- Every new table is workspace-scoped: FORCE RLS, `workspace_isolation`, `superuser_bypass`;
-- each cascades with its book (or its session), so the 30-day book purge takes it.

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "stressTestId" TEXT;

-- CreateTable
CREATE TABLE "StressTest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "outcome" TEXT,
    "confirmedWorstMicroUsd" BIGINT NOT NULL,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "coverage" JSONB,
    "metrics" JSONB,
    "promptVersion" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "StressTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StressWeakPoint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "stressTestId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "questions" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StressWeakPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GapHunt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "ranked" BOOLEAN NOT NULL,
    "unrankedReason" TEXT,
    "candidates" JSONB NOT NULL,
    "picks" TEXT NOT NULL,
    "bookMark" INTEGER NOT NULL,
    "elementsCut" BOOLEAN NOT NULL DEFAULT false,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "promptVersion" TEXT,
    "refusals" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GapHunt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewCompaction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "throughRound" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewCompaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StressTest_workspaceId_bookId_createdAt_idx" ON "StressTest"("workspaceId", "bookId", "createdAt");

-- CreateIndex
CREATE INDEX "StressTest_requestedById_idx" ON "StressTest"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "StressTest_workspaceId_id_key" ON "StressTest"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "StressWeakPoint_workspaceId_stressTestId_idx" ON "StressWeakPoint"("workspaceId", "stressTestId");

-- CreateIndex
CREATE UNIQUE INDEX "StressWeakPoint_stressTestId_position_key" ON "StressWeakPoint"("stressTestId", "position");

-- CreateIndex
CREATE INDEX "GapHunt_workspaceId_bookId_createdAt_idx" ON "GapHunt"("workspaceId", "bookId", "createdAt");

-- CreateIndex
CREATE INDEX "GapHunt_createdById_idx" ON "GapHunt"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "GapHunt_workspaceId_id_key" ON "GapHunt"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "InterviewCompaction_workspaceId_sessionId_idx" ON "InterviewCompaction"("workspaceId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewCompaction_sessionId_throughRound_key" ON "InterviewCompaction"("sessionId", "throughRound");

-- CreateIndex
CREATE INDEX "InterviewSession_stressTestId_idx" ON "InterviewSession"("stressTestId");

-- AddForeignKey
ALTER TABLE "StressTest" ADD CONSTRAINT "StressTest_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StressTest" ADD CONSTRAINT "StressTest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StressWeakPoint" ADD CONSTRAINT "StressWeakPoint_workspaceId_stressTestId_fkey" FOREIGN KEY ("workspaceId", "stressTestId") REFERENCES "StressTest"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GapHunt" ADD CONSTRAINT "GapHunt_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GapHunt" ADD CONSTRAINT "GapHunt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewCompaction" ADD CONSTRAINT "InterviewCompaction_workspaceId_sessionId_fkey" FOREIGN KEY ("workspaceId", "sessionId") REFERENCES "InterviewSession"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_stressTestId_fkey" FOREIGN KEY ("stressTestId") REFERENCES "StressTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Closed vocabularies ─────────────────────────────────────────────────
ALTER TABLE "StressTest" ADD CONSTRAINT "StressTest_status_known"
    CHECK ("status" IN ('QUEUED', 'RUNNING', 'DONE', 'STOPPED', 'FAILED'));
ALTER TABLE "StressTest" ADD CONSTRAINT "StressTest_outcome_known"
    CHECK ("outcome" IS NULL OR "outcome" IN ('OK', 'NONE_FOUND', 'NOT_ASSESSED', 'CEILING', 'KILL_SWITCH', 'AI_UNAVAILABLE', 'NOT_EVALUATED', 'MODEL_RATE_LIMITED', 'ESTIMATE_CHANGED', 'CALL_OVER_BUDGET', 'ABORTED', 'CLAIM_EXPIRED', 'CALL_FAILED', 'GUARD_REFUSED', 'BOOK_DELETED', 'NO_ACTOR', 'ENQUEUE_FAILED', 'INTERNAL'));
-- A finished test names how it ended; a live one names nothing yet.
ALTER TABLE "StressTest" ADD CONSTRAINT "StressTest_outcome_when_finished"
    CHECK (("status" IN ('QUEUED', 'RUNNING')) = ("outcome" IS NULL));
ALTER TABLE "StressTest" ADD CONSTRAINT "StressTest_money_not_negative"
    CHECK ("confirmedWorstMicroUsd" >= 0 AND "costMicroUsd" >= 0);

ALTER TABLE "StressWeakPoint" ADD CONSTRAINT "StressWeakPoint_kind_known"
    CHECK ("kind" IN ('UNMOTIVATED_TURN', 'COSTLESS_PROTAGONIST', 'UNARGUED_THEME', 'UNPAID_PROMISE', 'OTHER'));
ALTER TABLE "StressWeakPoint" ADD CONSTRAINT "StressWeakPoint_position_positive" CHECK ("position" >= 1);
-- Rule 2: a weak point rests on at least one cited row.
ALTER TABLE "StressWeakPoint" ADD CONSTRAINT "StressWeakPoint_cites_something"
    CHECK (jsonb_typeof("citations") = 'array' AND jsonb_array_length("citations") >= 1);
ALTER TABLE "StressWeakPoint" ADD CONSTRAINT "StressWeakPoint_flags_known"
    CHECK ("flags" <@ ARRAY['POSSIBLE_INSTRUCTION']::text[]);

ALTER TABLE "GapHunt" ADD CONSTRAINT "GapHunt_ranked_or_reason"
    CHECK ("ranked" = ("unrankedReason" IS NULL));
ALTER TABLE "GapHunt" ADD CONSTRAINT "GapHunt_unranked_reason_known"
    CHECK ("unrankedReason" IS NULL OR "unrankedReason" IN ('KILL_SWITCH', 'AI_UNAVAILABLE', 'WORKSPACE_CEILING', 'NOT_EVALUATED', 'CALL_OVER_BUDGET', 'MODEL_RATE_LIMITED', 'CALL_FAILED', 'GUARD_REFUSED', 'NO_VALID_PICK'));
ALTER TABLE "GapHunt" ADD CONSTRAINT "GapHunt_candidates_array" CHECK (jsonb_typeof("candidates") = 'array');
ALTER TABLE "GapHunt" ADD CONSTRAINT "GapHunt_money_not_negative" CHECK ("costMicroUsd" >= 0 AND "bookMark" >= 0);

ALTER TABLE "InterviewCompaction" ADD CONSTRAINT "InterviewCompaction_through_positive" CHECK ("throughRound" >= 1);

-- ─── The persona CHECKs: the panel joins the closed list ─────────────────
CREATE OR REPLACE FUNCTION interview_persona_list_ok(list jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT jsonb_typeof(list) = 'array'
        AND jsonb_array_length(list) <= 3
        AND list <@ '["gentle-mentor", "ruthless-editor", "socratic", "devils-advocate", "target-reader", "genre-specialist", "panel-target-reader", "panel-ruthless-editor", "panel-genre-specialist"]'::jsonb
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(list) AS e WHERE jsonb_typeof(e) <> 'string')
        AND jsonb_array_length(list) = (SELECT count(DISTINCT e) FROM jsonb_array_elements(list) AS e);
$$;

ALTER TABLE "InterviewSession" DROP CONSTRAINT "InterviewSession_personas_known";
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_personas_known"
    CHECK (
        cardinality("personaKeys") <= 3
        AND "personaKeys" <@ ARRAY['gentle-mentor', 'ruthless-editor', 'socratic', 'devils-advocate', 'target-reader', 'genre-specialist', 'panel-target-reader', 'panel-ruthless-editor', 'panel-genre-specialist']::text[]
        AND interview_text_array_distinct("personaKeys")
    );

-- A session started from a stress test is a SELECTION (its weak points' elements).
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_stress_test_is_selection"
    CHECK ("stressTestId" IS NULL OR "scope" = 'SELECTION');

-- ─── Fixed once written ──────────────────────────────────────────────────
-- A weak point and a compaction are a record of what a model call returned and code kept: app_user writes
-- them once; only their parent's cascade deletes them.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "StressWeakPoint" FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "InterviewCompaction" FROM app_user;

-- ─── Row-level security ──────────────────────────────────────────────────
ALTER TABLE "StressTest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StressTest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StressTest";
CREATE POLICY workspace_isolation ON "StressTest"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StressTest";
CREATE POLICY superuser_bypass ON "StressTest"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "StressWeakPoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StressWeakPoint" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StressWeakPoint";
CREATE POLICY workspace_isolation ON "StressWeakPoint"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StressWeakPoint";
CREATE POLICY superuser_bypass ON "StressWeakPoint"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "GapHunt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GapHunt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "GapHunt";
CREATE POLICY workspace_isolation ON "GapHunt"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "GapHunt";
CREATE POLICY superuser_bypass ON "GapHunt"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "InterviewCompaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterviewCompaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "InterviewCompaction";
CREATE POLICY workspace_isolation ON "InterviewCompaction"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "InterviewCompaction";
CREATE POLICY superuser_bypass ON "InterviewCompaction"
    USING (current_setting('role') != 'app_user');

