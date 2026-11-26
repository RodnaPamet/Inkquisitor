-- Phase 4.H-a: hardening Phase 4 — correctness and isolation (decision D31).
--
--   ContinuityRun.nightKey        the night a run was dispatched for (#62 item 4): one run a book a night, held
--                                 by a partial unique index, so a second dispatch in one night queues nothing
--                                 for a book that already has one (NULL for runs made before 4.H-a)
--   ContinuityCheck.pageFailures  the nights in a row the page at the pass's cursor failed (#62 item 3)
--   ContinuityCheck.parkedSubjects subjects of the pass passed over after `CONTINUITY_PAGE_FAILURES_MAX`
--                                 failed nights, counted and shown on the Continuity page (never silent)
--   Answer (workspaceId, id)      unique, so a cross-row key can name an answer with its workspace
--   Question.storyFactId,         composite (workspaceId, id) foreign keys like every other cross-row key
--   StoryFact.decidedByAnswerId   (#66 item 4): a question names a fact of its own workspace, and a fact an
--                                 answer of its own, in the database and not only in the code. Their deletion
--                                 sets only the id column NULL (`SET NULL (col)`, PostgreSQL 15+): the
--                                 workspace column is the row's own and NOT NULL.

-- ─── The nightly check ─────────────────────────────────────────────

ALTER TABLE "ContinuityRun" ADD COLUMN "nightKey" TEXT;
ALTER TABLE "ContinuityRun" ADD CONSTRAINT "ContinuityRun_night_key_shape" CHECK ("nightKey" IS NULL OR "nightKey" ~ '^[A-Za-z0-9:._-]{1,40}$');
CREATE UNIQUE INDEX "ContinuityRun_one_a_night" ON "ContinuityRun"("workspaceId", "bookId", "nightKey") WHERE "nightKey" IS NOT NULL;

ALTER TABLE "ContinuityCheck" ADD COLUMN "pageFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ContinuityCheck" ADD COLUMN "parkedSubjects" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ContinuityCheck" ADD CONSTRAINT "ContinuityCheck_page_counts" CHECK ("pageFailures" >= 0 AND "parkedSubjects" >= 0);

-- ─── Composite cross-row keys (#66 item 4) ─────────────────────────

CREATE UNIQUE INDEX "Answer_workspaceId_id_key" ON "Answer"("workspaceId", "id");

ALTER TABLE "Question" DROP CONSTRAINT "Question_storyFactId_fkey";
DROP INDEX "Question_storyFactId_idx";
CREATE INDEX "Question_workspaceId_storyFactId_idx" ON "Question"("workspaceId", "storyFactId");
ALTER TABLE "Question" ADD CONSTRAINT "Question_workspaceId_storyFactId_fkey"
    FOREIGN KEY ("workspaceId", "storyFactId") REFERENCES "StoryFact"("workspaceId", "id") ON DELETE SET NULL ("storyFactId") ON UPDATE CASCADE;

ALTER TABLE "StoryFact" DROP CONSTRAINT "StoryFact_decidedByAnswerId_fkey";
DROP INDEX "StoryFact_decidedByAnswerId_idx";
CREATE INDEX "StoryFact_workspaceId_decidedByAnswerId_idx" ON "StoryFact"("workspaceId", "decidedByAnswerId");
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_workspaceId_decidedByAnswerId_fkey"
    FOREIGN KEY ("workspaceId", "decidedByAnswerId") REFERENCES "Answer"("workspaceId", "id") ON DELETE SET NULL ("decidedByAnswerId") ON UPDATE CASCADE;
