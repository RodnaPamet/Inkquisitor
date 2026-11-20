-- Phase 2.4 — the interview experience. Two additions to Question, both
-- RLS-neutral (new columns on a table that already carries FORCE ROW LEVEL
-- SECURITY and the workspace_isolation / superuser_bypass policies; app_user's
-- table grants already cover them):
--
--   "Ask me this differently": a REPHRASE question replaces another of the
--   same session (and round). `replacesQuestionId` names it, through the
--   (workspaceId, sessionId, id) key, so the database refuses a rephrase of a
--   question in another session or workspace; the unique index allows one
--   rephrase per question (a rephrase may itself be rephrased). The replaced
--   question is stamped `supersededAt` and can no longer be answered (the
--   usecase refuses, and closing a round does not wait for it).
--
--   `reviewRequired`: the 2.1 guard flagged the call that worded the question
--   and let it go on ("flag and fence"); the UI marks it.
--
-- The new enum value is added here and only USED by later statements' rows at
-- run time (PostgreSQL refuses a value used in the transaction that adds it,
-- and migrate deploy runs each migration in one): nothing below names it.

-- AlterEnum
ALTER TYPE "QuestionOrigin" ADD VALUE 'REPHRASE';

-- AlterTable
ALTER TABLE "Question" ADD COLUMN "replacesQuestionId" TEXT,
ADD COLUMN "supersededAt" TIMESTAMP(3),
ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Question_workspaceId_sessionId_replacesQuestionId_key" ON "Question"("workspaceId", "sessionId", "replacesQuestionId");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_workspaceId_sessionId_replacesQuestionId_fkey" FOREIGN KEY ("workspaceId", "sessionId", "replacesQuestionId") REFERENCES "Question"("workspaceId", "sessionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A question never replaces itself.
ALTER TABLE "Question" ADD CONSTRAINT "Question_replaces_not_itself"
    CHECK ("replacesQuestionId" IS NULL OR "replacesQuestionId" <> "id");

-- A REPHRASE names the question it replaces (a pack example taken as a
-- rephrase is PACK_FALLBACK and names it too). Compared as text, so the
-- statement does not use the value this transaction added.
ALTER TABLE "Question" ADD CONSTRAINT "Question_rephrase_replaces"
    CHECK ("origin"::text <> 'REPHRASE' OR "replacesQuestionId" IS NOT NULL);
