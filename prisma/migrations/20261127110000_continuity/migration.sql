-- Phase 4.2 — continuity checks and open threads (decision D28).
--
--   StoryFactProposal     4.1's minimal record EXTENDED: a contradiction's kind, a DEEP basis, the
--                         nightly run that raised it, and a decision that keeps the older fact
--                         (INVALIDATED_NEWER) beside 4.1's three
--   StoryFact             a fourth kind, AUTHOR_RESOLUTION: the author's explanation of a
--                         contradiction they resolved as "both true", naming the proposal
--   ContinuityCheck/Run   the nightly deep check's state per book and its runs (counts and codes)
--   StoryThread           the registries, one table with a kind: PROMISE, CLUE, OPEN_QUESTION
--   StoryThreadProposal   a thread (or a thread's state) proposed by the product, citing a version
--   StaleFlag             propagation debt, raised by a trigger on the version table in the
--                         version's own transaction; cleared by the entry's next save (read) or
--                         the author's dismissal
--   InterviewSession      `staleFlagId`: "Grill me on what changed"
--
-- Every new table is workspace-scoped: FORCE RLS, `workspace_isolation`, `superuser_bypass`.

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "staleFlagId" TEXT;

-- AlterTable
ALTER TABLE "StoryFact" ADD COLUMN     "resolvesProposalId" TEXT;

-- AlterTable
ALTER TABLE "StoryFactProposal" ADD COLUMN     "checkRunId" TEXT,
ADD COLUMN     "kind" TEXT;

-- CreateTable
CREATE TABLE "ContinuityCheck" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "coveredThrough" TIMESTAMP(3),
    "passTarget" TIMESTAMP(3),
    "passCursor" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContinuityCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContinuityRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "outcome" TEXT,
    "passTarget" TIMESTAMP(3),
    "factsRead" INTEGER NOT NULL DEFAULT 0,
    "ruleProposals" INTEGER NOT NULL DEFAULT 0,
    "deepProposals" INTEGER NOT NULL DEFAULT 0,
    "subjectsCovered" INTEGER NOT NULL DEFAULT 0,
    "subjectsRemaining" INTEGER NOT NULL DEFAULT 0,
    "callsMade" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "promptVersion" TEXT,
    "metrics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ContinuityRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryThread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "subjectElementId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryThreadProposal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "proposedState" TEXT NOT NULL,
    "threadId" TEXT,
    "extractionId" TEXT,
    "bibleVersionId" TEXT,
    "relationVersionId" TEXT,
    "quote" TEXT NOT NULL,
    "quoteStart" INTEGER NOT NULL,
    "quoteEnd" INTEGER NOT NULL,
    "subjectElementId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryThreadProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaleFlag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "elementId" TEXT NOT NULL,
    "upstreamElementId" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'ANSWER',
    "citedVersionId" TEXT NOT NULL,
    "baseVersionId" TEXT,
    "upstreamVersionId" TEXT NOT NULL,
    "downstreamVersionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "dismissedById" TEXT,

    CONSTRAINT "StaleFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterviewSession_staleFlagId_idx" ON "InterviewSession"("staleFlagId");

-- CreateIndex
CREATE INDEX "ContinuityCheck_bookId_idx" ON "ContinuityCheck"("bookId");

-- CreateIndex
CREATE UNIQUE INDEX "ContinuityCheck_workspaceId_id_key" ON "ContinuityCheck"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ContinuityCheck_workspaceId_bookId_key" ON "ContinuityCheck"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "ContinuityRun_workspaceId_bookId_createdAt_idx" ON "ContinuityRun"("workspaceId", "bookId", "createdAt");

-- CreateIndex
CREATE INDEX "ContinuityRun_status_createdAt_idx" ON "ContinuityRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContinuityRun_workspaceId_id_key" ON "ContinuityRun"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "StoryThread_workspaceId_bookId_updatedAt_idx" ON "StoryThread"("workspaceId", "bookId", "updatedAt");

-- CreateIndex
CREATE INDEX "StoryThread_workspaceId_bookId_state_createdAt_idx" ON "StoryThread"("workspaceId", "bookId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "StoryThread_subjectElementId_idx" ON "StoryThread"("subjectElementId");

-- CreateIndex
CREATE INDEX "StoryThread_createdById_idx" ON "StoryThread"("createdById");

-- CreateIndex
CREATE INDEX "StoryThread_updatedById_idx" ON "StoryThread"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "StoryThread_workspaceId_id_key" ON "StoryThread"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "StoryThreadProposal_workspaceId_bookId_status_createdAt_idx" ON "StoryThreadProposal"("workspaceId", "bookId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "StoryThreadProposal_threadId_idx" ON "StoryThreadProposal"("threadId");

-- CreateIndex
CREATE INDEX "StoryThreadProposal_bibleVersionId_idx" ON "StoryThreadProposal"("bibleVersionId");

-- CreateIndex
CREATE INDEX "StoryThreadProposal_relationVersionId_idx" ON "StoryThreadProposal"("relationVersionId");

-- CreateIndex
CREATE INDEX "StoryThreadProposal_subjectElementId_idx" ON "StoryThreadProposal"("subjectElementId");

-- CreateIndex
CREATE INDEX "StoryThreadProposal_decidedById_idx" ON "StoryThreadProposal"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "StoryThreadProposal_workspaceId_id_key" ON "StoryThreadProposal"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StoryThreadProposal_workspaceId_bookId_dedupeKey_key" ON "StoryThreadProposal"("workspaceId", "bookId", "dedupeKey");

-- CreateIndex
CREATE INDEX "StaleFlag_workspaceId_bookId_status_raisedAt_idx" ON "StaleFlag"("workspaceId", "bookId", "status", "raisedAt");

-- CreateIndex
CREATE INDEX "StaleFlag_workspaceId_elementId_idx" ON "StaleFlag"("workspaceId", "elementId");

-- CreateIndex
CREATE INDEX "StaleFlag_workspaceId_upstreamElementId_idx" ON "StaleFlag"("workspaceId", "upstreamElementId");

-- CreateIndex
CREATE INDEX "StaleFlag_upstreamVersionId_idx" ON "StaleFlag"("upstreamVersionId");

-- CreateIndex
CREATE INDEX "StaleFlag_dismissedById_idx" ON "StaleFlag"("dismissedById");

-- CreateIndex
CREATE UNIQUE INDEX "StaleFlag_workspaceId_id_key" ON "StaleFlag"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StaleFlag_elementId_upstreamElementId_key" ON "StaleFlag"("elementId", "upstreamElementId");

-- CreateIndex
CREATE INDEX "BibleEntryVersion_sourceAnswerIds_idx" ON "BibleEntryVersion" USING GIN ("sourceAnswerIds");

-- CreateIndex
CREATE INDEX "StoryFact_workspaceId_resolvesProposalId_idx" ON "StoryFact"("workspaceId", "resolvesProposalId");

-- AddForeignKey
ALTER TABLE "ContinuityCheck" ADD CONSTRAINT "ContinuityCheck_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContinuityRun" ADD CONSTRAINT "ContinuityRun_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThread" ADD CONSTRAINT "StoryThread_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThread" ADD CONSTRAINT "StoryThread_subjectElementId_fkey" FOREIGN KEY ("subjectElementId") REFERENCES "BibleElement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThread" ADD CONSTRAINT "StoryThread_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThread" ADD CONSTRAINT "StoryThread_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThreadProposal" ADD CONSTRAINT "StoryThreadProposal_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThreadProposal" ADD CONSTRAINT "StoryThreadProposal_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "StoryThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThreadProposal" ADD CONSTRAINT "StoryThreadProposal_bibleVersionId_fkey" FOREIGN KEY ("bibleVersionId") REFERENCES "BibleEntryVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThreadProposal" ADD CONSTRAINT "StoryThreadProposal_relationVersionId_fkey" FOREIGN KEY ("relationVersionId") REFERENCES "BibleRelationVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThreadProposal" ADD CONSTRAINT "StoryThreadProposal_subjectElementId_fkey" FOREIGN KEY ("subjectElementId") REFERENCES "BibleElement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryThreadProposal" ADD CONSTRAINT "StoryThreadProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaleFlag" ADD CONSTRAINT "StaleFlag_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaleFlag" ADD CONSTRAINT "StaleFlag_workspaceId_elementId_fkey" FOREIGN KEY ("workspaceId", "elementId") REFERENCES "BibleElement"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaleFlag" ADD CONSTRAINT "StaleFlag_workspaceId_upstreamElementId_fkey" FOREIGN KEY ("workspaceId", "upstreamElementId") REFERENCES "BibleElement"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaleFlag" ADD CONSTRAINT "StaleFlag_upstreamVersionId_fkey" FOREIGN KEY ("upstreamVersionId") REFERENCES "BibleEntryVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaleFlag" ADD CONSTRAINT "StaleFlag_dismissedById_fkey" FOREIGN KEY ("dismissedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_staleFlagId_fkey" FOREIGN KEY ("staleFlagId") REFERENCES "StaleFlag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_workspaceId_resolvesProposalId_fkey" FOREIGN KEY ("workspaceId", "resolvesProposalId") REFERENCES "StoryFactProposal"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── StoryFact: the author's explanation is a fourth kind ─────────────────
ALTER TABLE "StoryFact" DROP CONSTRAINT "StoryFact_kind_columns";
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_kind_columns" CHECK (
    CASE "sourceKind"::text
        WHEN 'SOURCE_CHUNK' THEN "sourceId" IS NOT NULL AND "chunkId" IS NOT NULL AND "bookId" IS NULL AND "elementId" IS NULL
            AND "relationId" IS NULL AND "bibleVersionId" IS NULL AND "relationVersionId" IS NULL AND NOT "automatic" AND "dedupeKey" IS NULL
            AND "resolvesProposalId" IS NULL
        WHEN 'BIBLE_VERSION' THEN "sourceId" IS NULL AND "chunkId" IS NULL AND "bookId" IS NOT NULL AND "elementId" IS NOT NULL
            AND "relationId" IS NULL AND "bibleVersionId" IS NOT NULL AND "relationVersionId" IS NULL AND "automatic"
            AND "dedupeKey" IS NOT NULL AND "status" = 'CONFIRMED' AND "carriedFromFactId" IS NULL AND "resolvesProposalId" IS NULL
        WHEN 'RELATION_VERSION' THEN "sourceId" IS NULL AND "chunkId" IS NULL AND "bookId" IS NOT NULL AND "elementId" IS NULL
            AND "relationId" IS NOT NULL AND "bibleVersionId" IS NULL AND "relationVersionId" IS NOT NULL AND "automatic"
            AND "dedupeKey" IS NOT NULL AND "status" = 'CONFIRMED' AND "carriedFromFactId" IS NULL AND "resolvesProposalId" IS NULL
        -- The author's own words (never automatic), confirmed by being written, naming the contradiction they resolve.
        WHEN 'AUTHOR_RESOLUTION' THEN "sourceId" IS NULL AND "chunkId" IS NULL AND "bookId" IS NOT NULL AND "elementId" IS NULL
            AND "relationId" IS NULL AND "bibleVersionId" IS NULL AND "relationVersionId" IS NULL AND NOT "automatic"
            AND "dedupeKey" IS NULL AND "status" = 'CONFIRMED' AND "carriedFromFactId" IS NULL AND "resolvesProposalId" IS NOT NULL
            AND "decidedById" IS NOT NULL
        ELSE false
    END
);

-- 4.1's function (20261126140000), one column added to what never changes: the proposal an explanation resolves.
CREATE OR REPLACE FUNCTION story_fact_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId"
       OR NEW."chunkId" IS DISTINCT FROM OLD."chunkId" OR NEW."position" IS DISTINCT FROM OLD."position"
       OR NEW."sourceKind" IS DISTINCT FROM OLD."sourceKind" OR NEW."subjectName" IS DISTINCT FROM OLD."subjectName"
       OR NEW."predicate" IS DISTINCT FROM OLD."predicate" OR NEW."objectLiteral" IS DISTINCT FROM OLD."objectLiteral"
       OR NEW."statement" IS DISTINCT FROM OLD."statement" OR NEW."quote" IS DISTINCT FROM OLD."quote"
       OR NEW."quoteStart" IS DISTINCT FROM OLD."quoteStart" OR NEW."quoteEnd" IS DISTINCT FROM OLD."quoteEnd"
       OR NEW."storyTimeFrom" IS DISTINCT FROM OLD."storyTimeFrom" OR NEW."storyTimeTo" IS DISTINCT FROM OLD."storyTimeTo"
       OR NEW."statedAt" IS DISTINCT FROM OLD."statedAt" OR NEW."flags" IS DISTINCT FROM OLD."flags"
       OR NEW."carriedFromFactId" IS DISTINCT FROM OLD."carriedFromFactId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."bookId" IS DISTINCT FROM OLD."bookId" OR NEW."elementId" IS DISTINCT FROM OLD."elementId"
       OR NEW."relationId" IS DISTINCT FROM OLD."relationId" OR NEW."bibleVersionId" IS DISTINCT FROM OLD."bibleVersionId"
       OR NEW."relationVersionId" IS DISTINCT FROM OLD."relationVersionId" OR NEW."automatic" IS DISTINCT FROM OLD."automatic"
       OR NEW."dedupeKey" IS DISTINCT FROM OLD."dedupeKey" OR NEW."resolvesProposalId" IS DISTINCT FROM OLD."resolvesProposalId"
       OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt")
       OR (NEW."invalidatedByFactId" IS NOT NULL AND NEW."invalidatedByFactId" IS DISTINCT FROM OLD."invalidatedByFactId" AND OLD."supersededAt" IS NOT NULL)
       OR (NEW."invalidatedByFactId" IS NULL AND OLD."invalidatedByFactId" IS NOT NULL
           AND EXISTS (SELECT 1 FROM "StoryFact" n WHERE n."id" = OLD."invalidatedByFactId"))
       OR (NEW."subjectElementId" IS NOT NULL AND NEW."subjectElementId" IS DISTINCT FROM OLD."subjectElementId")
       OR (NEW."objectElementId" IS NOT NULL AND NEW."objectElementId" IS DISTINCT FROM OLD."objectElementId") THEN
        RAISE EXCEPTION 'STORY_FACT_FIXED: only a fact''s decision may change' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;

-- ─── StoryFactProposal: 4.1's record, extended ────────────────────────────
-- 4.1's contradictions get a kind: a RULE saw a single value that differs (VALUE), the MODEL judged one (OTHER).
UPDATE "StoryFactProposal" SET "kind" = CASE WHEN "basis" = 'RULE' THEN 'VALUE' ELSE 'OTHER' END WHERE "reason" = 'CONTRADICTED' AND "kind" IS NULL;

ALTER TABLE "StoryFactProposal" DROP CONSTRAINT "StoryFactProposal_known";
ALTER TABLE "StoryFactProposal" ADD CONSTRAINT "StoryFactProposal_known" CHECK (
    "status" IN ('PENDING', 'INVALIDATED', 'INVALIDATED_NEWER', 'KEPT', 'REJECTED')
    AND (("reason" = 'CONTRADICTED' AND "basis" IN ('RULE', 'MODEL', 'DEEP') AND "newerFactId" IS NOT NULL
          AND "kind" IN ('VALUE', 'WHEREABOUTS', 'KNOWLEDGE', 'TIMELINE', 'OTHER'))
      OR ("reason" = 'NO_LONGER_STATED' AND "basis" = 'TEXT' AND "newerFactId" IS NULL AND "kind" IS NULL AND "status" <> 'INVALIDATED_NEWER'))
    AND ("newerFactId" IS NULL OR "newerFactId" <> "factId")
    AND (("status" = 'PENDING') = ("decidedAt" IS NULL))
    -- The deep check raises proposals only from a nightly run, and names it; an extraction names its extraction.
    AND ("basis" <> 'DEEP' OR "checkRunId" IS NOT NULL)
);

-- 4.1's function, the two new columns added to what is fixed.
CREATE OR REPLACE FUNCTION story_fact_proposal_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."bookId" IS DISTINCT FROM OLD."bookId"
       OR NEW."factId" IS DISTINCT FROM OLD."factId" OR NEW."newerFactId" IS DISTINCT FROM OLD."newerFactId"
       OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."basis" IS DISTINCT FROM OLD."basis"
       OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."checkRunId" IS DISTINCT FROM OLD."checkRunId"
       OR NEW."extractionId" IS DISTINCT FROM OLD."extractionId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR (OLD."status" <> 'PENDING' AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
           OR (NEW."decidedById" IS NOT NULL AND NEW."decidedById" IS DISTINCT FROM OLD."decidedById"))) THEN
        RAISE EXCEPTION 'STORY_FACT_PROPOSAL_FIXED: only a pending proposal''s decision may be written, once' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;

-- ─── The nightly check ─────────────────────────────────────────────────
ALTER TABLE "ContinuityRun" ADD CONSTRAINT "ContinuityRun_status_known" CHECK ("status" IN ('QUEUED', 'RUNNING', 'DONE', 'STOPPED', 'SKIPPED', 'FAILED'));
ALTER TABLE "ContinuityRun" ADD CONSTRAINT "ContinuityRun_outcome_known" CHECK ("outcome" IS NULL OR "outcome" IN (
    'OK', 'PAGED', 'NO_FACTS', 'NOTHING_NEW', 'BOOK_DELETED', 'NO_ACTOR', 'CEILING', 'KILL_SWITCH', 'AI_UNAVAILABLE', 'NOT_EVALUATED',
    'MODEL_RATE_LIMITED', 'CALL_FAILED', 'GUARD_REFUSED', 'CALL_OVER_BUDGET', 'ABORTED', 'CLAIM_EXPIRED', 'INTERNAL'));
ALTER TABLE "ContinuityRun" ADD CONSTRAINT "ContinuityRun_counts" CHECK (
    "factsRead" >= 0 AND "ruleProposals" >= 0 AND "deepProposals" >= 0 AND "subjectsCovered" >= 0 AND "subjectsRemaining" >= 0
    AND "callsMade" >= 0 AND "costMicroUsd" >= 0);

-- ─── The registries ────────────────────────────────────────────────────
ALTER TABLE "StoryThread" ADD CONSTRAINT "StoryThread_kind_state" CHECK (
    ("kind" = 'PROMISE' AND "state" IN ('OPEN', 'PAID_OFF', 'DROPPED'))
    OR ("kind" = 'CLUE' AND "state" IN ('OPEN', 'REVEALED', 'DROPPED'))
    OR ("kind" = 'OPEN_QUESTION' AND "state" IN ('OPEN', 'RESOLVED'))
);
ALTER TABLE "StoryThread" ADD CONSTRAINT "StoryThread_version" CHECK ("version" >= 1);

ALTER TABLE "StoryThreadProposal" ADD CONSTRAINT "StoryThreadProposal_known" CHECK (
    "kind" IN ('PROMISE', 'CLUE', 'OPEN_QUESTION')
    AND "status" IN ('PENDING', 'ACCEPTED', 'REJECTED')
    AND (("status" = 'PENDING') = ("decidedAt" IS NULL))
    AND (("op" = 'NEW_THREAD' AND "title" IS NOT NULL AND "proposedState" = 'OPEN')
      OR ("op" = 'SET_STATE' AND "title" IS NULL AND (
            ("kind" = 'PROMISE' AND "proposedState" IN ('PAID_OFF', 'DROPPED'))
         OR ("kind" = 'CLUE' AND "proposedState" IN ('REVEALED', 'DROPPED'))
         OR ("kind" = 'OPEN_QUESTION' AND "proposedState" = 'RESOLVED'))))
    AND (("bibleVersionId" IS NULL) <> ("relationVersionId" IS NULL))
    AND "quoteStart" >= 0 AND "quoteEnd" > "quoteStart"
);
ALTER TABLE "StoryThreadProposal" ADD CONSTRAINT "StoryThreadProposal_dedupe_key_shape" CHECK ("dedupeKey" ~ '^[0-9a-f]{64}$');

-- A thread proposal is fixed but for its one decision, made once: the status, who, when, and (on accepting a new
-- thread) the thread it created. The thread pointer goes back to NULL only by its foreign key, with the thread.
CREATE OR REPLACE FUNCTION story_thread_proposal_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."bookId" IS DISTINCT FROM OLD."bookId"
       OR NEW."op" IS DISTINCT FROM OLD."op" OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."title" IS DISTINCT FROM OLD."title" OR NEW."proposedState" IS DISTINCT FROM OLD."proposedState"
       OR NEW."extractionId" IS DISTINCT FROM OLD."extractionId" OR NEW."bibleVersionId" IS DISTINCT FROM OLD."bibleVersionId"
       OR NEW."relationVersionId" IS DISTINCT FROM OLD."relationVersionId" OR NEW."quote" IS DISTINCT FROM OLD."quote"
       OR NEW."quoteStart" IS DISTINCT FROM OLD."quoteStart" OR NEW."quoteEnd" IS DISTINCT FROM OLD."quoteEnd"
       OR NEW."dedupeKey" IS DISTINCT FROM OLD."dedupeKey" OR NEW."flags" IS DISTINCT FROM OLD."flags"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR (NEW."subjectElementId" IS NOT NULL AND NEW."subjectElementId" IS DISTINCT FROM OLD."subjectElementId")
       OR (NEW."threadId" IS NOT NULL AND NEW."threadId" IS DISTINCT FROM OLD."threadId"
           AND NOT (OLD."threadId" IS NULL AND OLD."status" = 'PENDING' AND OLD."op" = 'NEW_THREAD'))
       OR (OLD."status" <> 'PENDING' AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
           OR (NEW."decidedById" IS NOT NULL AND NEW."decidedById" IS DISTINCT FROM OLD."decidedById"))) THEN
        RAISE EXCEPTION 'STORY_THREAD_PROPOSAL_FIXED: only a pending proposal''s decision may be written, once' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS story_thread_proposal_fixed ON "StoryThreadProposal";
CREATE TRIGGER story_thread_proposal_fixed BEFORE UPDATE ON "StoryThreadProposal" FOR EACH ROW EXECUTE FUNCTION story_thread_proposal_fixed();

-- A thread or a proposal names an element of its own book, never another's (the single-column foreign keys cannot say so).
CREATE OR REPLACE FUNCTION story_thread_subject_in_book() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."subjectElementId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "BibleElement" WHERE "id" = NEW."subjectElementId" AND "workspaceId" = NEW."workspaceId" AND "bookId" = NEW."bookId") THEN
        RAISE EXCEPTION 'STORY_THREAD_SUBJECT_FOREIGN: the element is not in this book' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS story_thread_subject_in_book ON "StoryThread";
CREATE TRIGGER story_thread_subject_in_book BEFORE INSERT OR UPDATE OF "subjectElementId" ON "StoryThread"
    FOR EACH ROW EXECUTE FUNCTION story_thread_subject_in_book();
DROP TRIGGER IF EXISTS story_thread_proposal_subject_in_book ON "StoryThreadProposal";
CREATE TRIGGER story_thread_proposal_subject_in_book BEFORE INSERT OR UPDATE OF "subjectElementId" ON "StoryThreadProposal"
    FOR EACH ROW EXECUTE FUNCTION story_thread_subject_in_book();

-- ─── Propagation debt ──────────────────────────────────────────────────
ALTER TABLE "StaleFlag" ADD CONSTRAINT "StaleFlag_known" CHECK (
    "basis" IN ('ANSWER')
    AND "status" IN ('OPEN', 'DISMISSED', 'CLEARED')
    AND (("status" = 'DISMISSED') = ("dismissedAt" IS NOT NULL))
    AND "elementId" <> "upstreamElementId"
    AND "downstreamVersionNumber" >= 1
);

-- A grill session is a SELECTION of its one element (the usecase holds the rest).
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_stale_flag_scope" CHECK ("staleFlagId" IS NULL OR "scope" = 'SELECTION');

-- WHEN AN ELEMENT CHANGES, the entries whose accepted versions CITED it may be stale (D28, direct citations only):
-- an entry D cites the changed element U when one of D's versions names, in `sourceAnswerIds`, an ANSWERED answer to a
-- question about U (filed under U, not about an element not yet created, or about a relation with U at one end).
-- Nothing transitive. A reorder (`movedInOrder`) changes nothing a citation rests on and raises nothing.
--
-- Written IN THE VERSION'S TRANSACTION, like 4.1's outbox: a rolled-back save raises nothing. One row per pair: a flag
-- still open (its entry not saved since) keeps the earliest change's base version; a cleared or dismissed one opens
-- again with this change as its base. Rows are written in element order, so two saves never lock them crosswise.
-- Bounded: the newest 2,000 answers about U, 500 citing entries.
CREATE OR REPLACE FUNCTION bible_entry_version_stale_flags() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    answer_ids text[];
    base_id text;
BEGIN
    IF NEW."movedInOrder" THEN
        RETURN NULL;
    END IF;
    SELECT array_agg(x."id") INTO answer_ids FROM (
        SELECT a."id" FROM "Answer" a
        JOIN "Question" q ON q."workspaceId" = a."workspaceId" AND q."sessionId" = a."sessionId" AND q."id" = a."questionId"
        WHERE a."workspaceId" = NEW."workspaceId" AND q."bookId" = NEW."bookId" AND a."status" = 'ANSWERED' AND NOT q."aboutPending"
          AND (q."elementId" = NEW."elementId"
               OR q."relationId" IN (SELECT r."id" FROM "BibleRelation" r
                                     WHERE r."bookId" = NEW."bookId" AND (r."fromElementId" = NEW."elementId" OR r."toElementId" = NEW."elementId")))
        ORDER BY a."createdAt" DESC
        LIMIT 2000
    ) x;
    IF answer_ids IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT v."id" INTO base_id FROM "BibleEntryVersion" v
        WHERE v."elementId" = NEW."elementId" AND v."versionNumber" < NEW."versionNumber"
        ORDER BY v."versionNumber" DESC LIMIT 1;
    INSERT INTO "StaleFlag" ("id", "workspaceId", "bookId", "elementId", "upstreamElementId", "basis", "citedVersionId",
                             "baseVersionId", "upstreamVersionId", "downstreamVersionNumber", "status", "raisedAt")
    SELECT gen_random_uuid()::text, NEW."workspaceId", NEW."bookId", c."elementId", NEW."elementId", 'ANSWER', c."citedVersionId",
           base_id, NEW."id", c."newest", 'OPEN', now()
    FROM (
        SELECT v."elementId",
               (array_agg(v."id" ORDER BY v."versionNumber" DESC))[1] AS "citedVersionId",
               (SELECT max(w."versionNumber") FROM "BibleEntryVersion" w WHERE w."elementId" = v."elementId") AS "newest"
        FROM "BibleEntryVersion" v
        WHERE v."workspaceId" = NEW."workspaceId" AND v."bookId" = NEW."bookId" AND v."elementId" <> NEW."elementId"
          AND v."sourceAnswerIds" && answer_ids
          AND EXISTS (SELECT 1 FROM "BibleElement" e WHERE e."id" = v."elementId" AND e."workspaceId" = NEW."workspaceId")
        GROUP BY v."elementId"
        ORDER BY v."elementId"
        LIMIT 500
    ) c
    ORDER BY c."elementId"
    ON CONFLICT ("elementId", "upstreamElementId") DO UPDATE SET
        "upstreamVersionId" = EXCLUDED."upstreamVersionId",
        "citedVersionId" = EXCLUDED."citedVersionId",
        "baseVersionId" = CASE
            WHEN "StaleFlag"."status" = 'OPEN' AND NOT EXISTS (
                SELECT 1 FROM "BibleEntryVersion" w WHERE w."elementId" = "StaleFlag"."elementId"
                  AND w."versionNumber" > "StaleFlag"."downstreamVersionNumber" AND NOT w."movedInOrder")
            THEN "StaleFlag"."baseVersionId" ELSE EXCLUDED."baseVersionId" END,
        "downstreamVersionNumber" = CASE
            WHEN "StaleFlag"."status" = 'OPEN' AND NOT EXISTS (
                SELECT 1 FROM "BibleEntryVersion" w WHERE w."elementId" = "StaleFlag"."elementId"
                  AND w."versionNumber" > "StaleFlag"."downstreamVersionNumber" AND NOT w."movedInOrder")
            THEN "StaleFlag"."downstreamVersionNumber" ELSE EXCLUDED."downstreamVersionNumber" END,
        "status" = 'OPEN',
        "raisedAt" = now(),
        "dismissedAt" = NULL,
        "dismissedById" = NULL;
    RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS bible_entry_version_stale_flags ON "BibleEntryVersion";
CREATE TRIGGER bible_entry_version_stale_flags AFTER INSERT ON "BibleEntryVersion" FOR EACH ROW EXECUTE FUNCTION bible_entry_version_stale_flags();

-- ─── Row-level security ────────────────────────────────────────────────
ALTER TABLE "ContinuityCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContinuityCheck" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ContinuityCheck";
CREATE POLICY workspace_isolation ON "ContinuityCheck"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ContinuityCheck";
CREATE POLICY superuser_bypass ON "ContinuityCheck"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "ContinuityRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContinuityRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ContinuityRun";
CREATE POLICY workspace_isolation ON "ContinuityRun"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ContinuityRun";
CREATE POLICY superuser_bypass ON "ContinuityRun"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "StoryThread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoryThread" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StoryThread";
CREATE POLICY workspace_isolation ON "StoryThread"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StoryThread";
CREATE POLICY superuser_bypass ON "StoryThread"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "StoryThreadProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoryThreadProposal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StoryThreadProposal";
CREATE POLICY workspace_isolation ON "StoryThreadProposal"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StoryThreadProposal";
CREATE POLICY superuser_bypass ON "StoryThreadProposal"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "StaleFlag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaleFlag" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StaleFlag";
CREATE POLICY workspace_isolation ON "StaleFlag"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StaleFlag";
CREATE POLICY superuser_bypass ON "StaleFlag"
    USING (current_setting('role') != 'app_user');
