-- Phase 2.5 — enrichment: an interview's answers become proposed bible
-- changes the author reviews.
--
--   ReconcileRun          one per closed round: the reconcile step's claim,
--                         status and outcome, counts only (no text).
--   EnrichmentProposal    a proposed change to one field (ADD / UPDATE /
--                         REMOVE) or a proposed new element; value, name and
--                         summary encrypted by the application.
--   EnrichmentCitation    the answers a proposal is drawn from (rule 2).
--   Answer                gains the unique key (workspaceId, sessionId, id) a
--                         citation's foreign key names.
--   BibleEntryVersion     gains `sourceAnswerIds`: the answers an INTERVIEW
--                         version is drawn from (rule 1), written at insert.
--
-- The enums, tables, indexes and foreign keys are what `prisma migrate diff`
-- generates from prisma/schema/; the CHECKs, the triggers, the grants and the
-- row-level security are appended by hand below.
--
-- ROLLING-DEPLOY SAFETY. Forward-only and additive: new enums and tables the
-- previous image never reads; a unique index over Answer columns that are
-- already unique by `id`; a column on BibleEntryVersion with a default, whose
-- CHECK the previous image always satisfies (it never writes INTERVIEW).

-- CreateEnum
CREATE TYPE "EnrichmentOperation" AS ENUM ('ADD', 'UPDATE', 'REMOVE');

-- CreateEnum
CREATE TYPE "EnrichmentProposalKind" AS ENUM ('FIELD', 'NEW_ELEMENT');

-- CreateEnum
CREATE TYPE "EnrichmentProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ReconcileRunStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED', 'REFUSED');

-- AlterTable
ALTER TABLE "BibleEntryVersion" ADD COLUMN     "sourceAnswerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ReconcileRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "status" "ReconcileRunStatus" NOT NULL DEFAULT 'RUNNING',
    "outcome" TEXT,
    "metrics" JSONB,
    "promptVersion" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ReconcileRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrichmentProposal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "kind" "EnrichmentProposalKind" NOT NULL,
    "elementId" TEXT,
    "fieldKey" TEXT,
    "operation" "EnrichmentOperation",
    "proposedValue" TEXT,
    "baseVersion" INTEGER,
    "newKind" "BibleElementKind",
    "newName" TEXT,
    "newSummary" TEXT,
    "status" "EnrichmentProposalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "versionId" TEXT,
    "createdElementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrichmentProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrichmentCitation" (
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "answerId" TEXT NOT NULL,

    CONSTRAINT "EnrichmentCitation_pkey" PRIMARY KEY ("proposalId","answerId")
);

-- CreateIndex
CREATE INDEX "ReconcileRun_workspaceId_sessionId_idx" ON "ReconcileRun"("workspaceId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconcileRun_sessionId_roundId_key" ON "ReconcileRun"("sessionId", "roundId");

-- CreateIndex
CREATE INDEX "EnrichmentProposal_workspaceId_sessionId_createdAt_idx" ON "EnrichmentProposal"("workspaceId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "EnrichmentProposal_workspaceId_bookId_status_idx" ON "EnrichmentProposal"("workspaceId", "bookId", "status");

-- CreateIndex
CREATE INDEX "EnrichmentProposal_sessionId_roundId_idx" ON "EnrichmentProposal"("sessionId", "roundId");

-- CreateIndex
CREATE INDEX "EnrichmentProposal_elementId_fieldKey_idx" ON "EnrichmentProposal"("elementId", "fieldKey");

-- CreateIndex
CREATE INDEX "EnrichmentProposal_decidedById_idx" ON "EnrichmentProposal"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "EnrichmentProposal_workspaceId_sessionId_id_key" ON "EnrichmentProposal"("workspaceId", "sessionId", "id");

-- CreateIndex
CREATE INDEX "EnrichmentCitation_workspaceId_sessionId_answerId_idx" ON "EnrichmentCitation"("workspaceId", "sessionId", "answerId");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_workspaceId_sessionId_id_key" ON "Answer"("workspaceId", "sessionId", "id");

-- AddForeignKey
ALTER TABLE "ReconcileRun" ADD CONSTRAINT "ReconcileRun_workspaceId_sessionId_fkey" FOREIGN KEY ("workspaceId", "sessionId") REFERENCES "InterviewSession"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconcileRun" ADD CONSTRAINT "ReconcileRun_sessionId_roundId_fkey" FOREIGN KEY ("sessionId", "roundId") REFERENCES "InterviewRound"("sessionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_workspaceId_bookId_sessionId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sessionId") REFERENCES "InterviewSession"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_sessionId_roundId_fkey" FOREIGN KEY ("sessionId", "roundId") REFERENCES "InterviewRound"("sessionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "BibleElement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentCitation" ADD CONSTRAINT "EnrichmentCitation_workspaceId_sessionId_proposalId_fkey" FOREIGN KEY ("workspaceId", "sessionId", "proposalId") REFERENCES "EnrichmentProposal"("workspaceId", "sessionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentCitation" ADD CONSTRAINT "EnrichmentCitation_workspaceId_sessionId_answerId_fkey" FOREIGN KEY ("workspaceId", "sessionId", "answerId") REFERENCES "Answer"("workspaceId", "sessionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the three tables are workspace-scoped
-- ═══════════════════════════════════════════════════════════════════
--
-- The same set as every scoped table (docs/rls-workspace-isolation.md).

ALTER TABLE "ReconcileRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReconcileRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ReconcileRun";
CREATE POLICY workspace_isolation ON "ReconcileRun"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ReconcileRun";
CREATE POLICY superuser_bypass ON "ReconcileRun"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "EnrichmentProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EnrichmentProposal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "EnrichmentProposal";
CREATE POLICY workspace_isolation ON "EnrichmentProposal"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "EnrichmentProposal";
CREATE POLICY superuser_bypass ON "EnrichmentProposal"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "EnrichmentCitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EnrichmentCitation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "EnrichmentCitation";
CREATE POLICY workspace_isolation ON "EnrichmentCitation"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "EnrichmentCitation";
CREATE POLICY superuser_bypass ON "EnrichmentCitation"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- Shape the database holds whoever writes
-- ═══════════════════════════════════════════════════════════════════

-- A run's outcome is a code from the closed list (src/lib/enrichment/vocabulary.ts,
-- RECONCILE_OUTCOMES), set exactly when the run has ended; a running run has none.
ALTER TABLE "ReconcileRun" ADD CONSTRAINT "ReconcileRun_outcome_known"
    CHECK ("outcome" IS NULL OR "outcome" IN (
        'OK', 'NOTHING_TO_RECONCILE', 'GUARD_REFUSED', 'TIMEOUT', 'ABORTED', 'PROVIDER_FAILURE',
        'INVALID_OUTPUT', 'KILL_SWITCH', 'WORKSPACE_CEILING', 'PROMPT_INVALID', 'AI_UNAVAILABLE',
        'RECONCILE_NOT_EVALUATED', 'CLAIM_EXPIRED'));
ALTER TABLE "ReconcileRun" ADD CONSTRAINT "ReconcileRun_outcome_with_status"
    CHECK (("status" = 'RUNNING') = ("outcome" IS NULL)
       AND ("status" = 'RUNNING') = ("finishedAt" IS NULL)
       AND ("status" <> 'DONE' OR "outcome" IN ('OK', 'NOTHING_TO_RECONCILE'))
       AND ("status" <> 'REFUSED' OR "outcome" IN ('AI_UNAVAILABLE', 'RECONCILE_NOT_EVALUATED')));
ALTER TABLE "ReconcileRun" ADD CONSTRAINT "ReconcileRun_attempts_positive" CHECK ("attempts" >= 1);
ALTER TABLE "ReconcileRun" ADD CONSTRAINT "ReconcileRun_promptVersion_shape"
    CHECK (char_length("promptVersion") BETWEEN 1 AND 64 AND "promptVersion" ~ '^[A-Za-z0-9._+-]+$');

-- A FIELD proposal names an element, a field and an operation and nothing of a
-- new element; a NEW_ELEMENT proposal the reverse. A REMOVE carries no value,
-- an ADD or UPDATE one.
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_kind_shape"
    CHECK (
        ("kind" = 'FIELD'
            AND "elementId" IS NOT NULL AND "fieldKey" IS NOT NULL AND "operation" IS NOT NULL AND "baseVersion" IS NOT NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND (("operation" = 'REMOVE') = ("proposedValue" IS NULL)))
        OR
        ("kind" = 'NEW_ELEMENT'
            AND "elementId" IS NULL AND "fieldKey" IS NULL AND "operation" IS NULL AND "proposedValue" IS NULL AND "baseVersion" IS NULL
            AND "newKind" IS NOT NULL AND "newName" IS NOT NULL AND "versionId" IS NULL)
    );
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_fieldKey_shape"
    CHECK ("fieldKey" IS NULL OR ("fieldKey" ~ '^[a-z][a-z0-9_]*$' AND char_length("fieldKey") <= 64));
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_baseVersion_positive"
    CHECK ("baseVersion" IS NULL OR "baseVersion" >= 1);
-- A decided proposal says when; an accepted one points at what it wrote.
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_decision_shape"
    CHECK (
        ("status" = 'PENDING') = ("decidedAt" IS NULL)
        AND ("status" <> 'PENDING' OR ("decidedById" IS NULL AND "versionId" IS NULL AND "createdElementId" IS NULL))
        AND ("status" NOT IN ('ACCEPTED', 'EDITED_ACCEPTED')
             OR ("kind" = 'FIELD' AND "versionId" IS NOT NULL)
             OR ("kind" = 'NEW_ELEMENT' AND "createdElementId" IS NOT NULL))
        AND ("status" IN ('ACCEPTED', 'EDITED_ACCEPTED') OR ("versionId" IS NULL AND "createdElementId" IS NULL))
    );

-- An INTERVIEW version names the answers it is drawn from (rule 1); no other
-- version names any.
ALTER TABLE "BibleEntryVersion" ADD CONSTRAINT "BibleEntryVersion_interview_names_answers"
    CHECK (("source" = 'INTERVIEW') = (cardinality(coalesce("sourceAnswerIds", ARRAY[]::text[])) > 0));

-- ═══════════════════════════════════════════════════════════════════
-- A FIELD proposal's element is in the proposal's book
-- ═══════════════════════════════════════════════════════════════════
--
-- Prisma cannot declare an optional relation over (bookId, elementId) while
-- bookId is required, so the element's foreign key is by id alone; this
-- trigger holds the rest. It runs as the inserting role, under its row-level
-- security, so another workspace's element is not even visible to it. It (and
-- the citation's check below) is an AFTER trigger, so a row of another
-- workspace is refused by the row-level security policy first, as on every
-- scoped table.

CREATE OR REPLACE FUNCTION enrichment_proposal_element_in_book() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NEW."elementId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "BibleElement" WHERE "id" = NEW."elementId" AND "bookId" = NEW."bookId" AND "workspaceId" = NEW."workspaceId"
    ) THEN
        RAISE EXCEPTION 'ENRICHMENT_ELEMENT_NOT_IN_BOOK: a proposal names an element outside its book'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enrichment_proposal_element_in_book ON "EnrichmentProposal";
CREATE TRIGGER enrichment_proposal_element_in_book
    AFTER INSERT OR UPDATE OF "elementId", "bookId" ON "EnrichmentProposal"
    FOR EACH ROW EXECUTE FUNCTION enrichment_proposal_element_in_book();

-- ═══════════════════════════════════════════════════════════════════
-- What the model proposed is never rewritten
-- ═══════════════════════════════════════════════════════════════════
--
-- A proposal's content is fixed at insert. The only writes after it are the
-- author's decision, ONCE: from PENDING to ACCEPTED, EDITED_ACCEPTED, REJECTED
-- or SUPERSEDED, touching only the decision columns (status, decidedById,
-- decidedAt, versionId, createdElementId); and the clearing of `decidedById`
-- when that person's account is deleted (ON DELETE SET NULL). An edited
-- acceptance does not overwrite the proposed value: what the author wrote is in
-- the version it made. app_user may not delete a proposal; its session's (or
-- element's, round's, book's, workspace's) cascade does.

REVOKE DELETE, TRUNCATE ON TABLE "EnrichmentProposal" FROM app_user;

CREATE OR REPLACE FUNCTION enrichment_proposal_fixed() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    decision_cols text[] := ARRAY['status', 'decidedById', 'decidedAt', 'versionId', 'createdElementId'];
BEGIN
    IF OLD."status" = 'PENDING'
       AND NEW."status" <> 'PENDING'
       AND (to_jsonb(NEW) - decision_cols) = (to_jsonb(OLD) - decision_cols) THEN
        RETURN NEW;
    END IF;
    IF OLD."decidedById" IS NOT NULL
       AND NEW."decidedById" IS NULL
       AND (to_jsonb(NEW) - 'decidedById') = (to_jsonb(OLD) - 'decidedById')
       AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."decidedById") THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ENRICHMENT_PROPOSAL_FIXED: a proposal changes only by its one decision'
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS enrichment_proposal_fixed ON "EnrichmentProposal";
CREATE TRIGGER enrichment_proposal_fixed
    BEFORE UPDATE ON "EnrichmentProposal"
    FOR EACH ROW EXECUTE FUNCTION enrichment_proposal_fixed();

-- ═══════════════════════════════════════════════════════════════════
-- Rule 2: a proposal cites at least one ANSWERED answer of its session
-- ═══════════════════════════════════════════════════════════════════
--
-- The citation's foreign key already refuses an answer of another session.
-- Its insert trigger refuses an answer that is not ANSWERED (a skip or a
-- "decide later" is no source). A deferred constraint trigger refuses, at
-- commit, a proposal inserted with no citation at all: the usecase writes the
-- proposal and its citations in one transaction, and the database checks the
-- result. A citation is never changed: app_user holds no UPDATE or DELETE on
-- the table (a cascade from its proposal or answer removes it).

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "EnrichmentCitation" FROM app_user;

CREATE OR REPLACE FUNCTION enrichment_citation_answered() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "Answer"
        WHERE "id" = NEW."answerId" AND "sessionId" = NEW."sessionId" AND "workspaceId" = NEW."workspaceId" AND "status" = 'ANSWERED'
    ) THEN
        RAISE EXCEPTION 'ENRICHMENT_CITES_UNANSWERED: a proposal may cite only an ANSWERED answer of its session'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enrichment_citation_answered ON "EnrichmentCitation";
CREATE TRIGGER enrichment_citation_answered
    AFTER INSERT ON "EnrichmentCitation"
    FOR EACH ROW EXECUTE FUNCTION enrichment_citation_answered();

CREATE OR REPLACE FUNCTION enrichment_proposal_cites_an_answer() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    -- The proposal may already be gone (inserted and cascaded away in one
    -- transaction): nothing is left to hold to the rule.
    IF EXISTS (SELECT 1 FROM "EnrichmentProposal" WHERE "id" = NEW."id")
       AND NOT EXISTS (SELECT 1 FROM "EnrichmentCitation" WHERE "proposalId" = NEW."id") THEN
        RAISE EXCEPTION 'ENRICHMENT_CITES_NO_ANSWER: a proposal must cite at least one answer'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS enrichment_proposal_cites_an_answer ON "EnrichmentProposal";
CREATE CONSTRAINT TRIGGER enrichment_proposal_cites_an_answer
    AFTER INSERT ON "EnrichmentProposal"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enrichment_proposal_cites_an_answer();
