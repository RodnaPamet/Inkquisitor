-- ═══════════════════════════════════════════════════════════════════
-- Phase 3.3 — interview from the canvas (decision D24)
-- ═══════════════════════════════════════════════════════════════════
--
--   BibleRelationField     a relation's own fields, keyed by its type's
--                          template fields (value encrypted)
--   BibleRelationVersion   a relation's history, append-only, numbered per
--                          relation under its advisory lock; an INTERVIEW
--                          version names the answers it is drawn from
--   InterviewSession       SELECTION (elements and relations from a map) and
--                          BETWEEN (a beat not yet created between two
--                          neighbours) scopes
--   Question               a question about a relation, or about a BETWEEN
--                          session's element not yet created
--   EnrichmentProposal     RELATION_FIELD and NEW_RELATION proposals; a
--                          NEW_ELEMENT that fills a BETWEEN session's slot
--
-- The tables, columns, indexes and foreign keys are what `prisma migrate diff`
-- generates from prisma/schema/; the CHECKs, row-level security and triggers
-- are hand-written below. Additive: a previous image never writes the new
-- columns, and every CHECK below holds for the rows it writes.


-- AlterTable
ALTER TABLE "EnrichmentProposal" ADD COLUMN     "createdRelationId" TEXT,
ADD COLUMN     "fillsSlot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "newFromElementId" TEXT,
ADD COLUMN     "newFromProposalId" TEXT,
ADD COLUMN     "newRelationType" TEXT,
ADD COLUMN     "newToElementId" TEXT,
ADD COLUMN     "newToProposalId" TEXT,
ADD COLUMN     "relationId" TEXT;

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "scopeElementIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scopeRelationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "slotAct" TEXT,
ADD COLUMN     "slotAfterElementId" TEXT,
ADD COLUMN     "slotBeforeElementId" TEXT,
ADD COLUMN     "slotKind" "BibleElementKind";

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "aboutPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "relationId" TEXT;

-- CreateTable
CREATE TABLE "BibleRelationField" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BibleRelationField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BibleRelationVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "changeSummary" TEXT,
    "source" "BibleVersionSource" NOT NULL,
    "sourceAnswerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BibleRelationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BibleRelationField_workspaceId_relationId_idx" ON "BibleRelationField"("workspaceId", "relationId");

-- CreateIndex
CREATE UNIQUE INDEX "BibleRelationField_relationId_key_key" ON "BibleRelationField"("relationId", "key");

-- CreateIndex
CREATE INDEX "BibleRelationVersion_workspaceId_bookId_idx" ON "BibleRelationVersion"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "BibleRelationVersion_authorId_idx" ON "BibleRelationVersion"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "BibleRelationVersion_relationId_versionNumber_key" ON "BibleRelationVersion"("relationId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BibleRelation_workspaceId_id_key" ON "BibleRelation"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "EnrichmentProposal_relationId_fieldKey_idx" ON "EnrichmentProposal"("relationId", "fieldKey");

-- CreateIndex
CREATE INDEX "EnrichmentProposal_newFromElementId_idx" ON "EnrichmentProposal"("newFromElementId");

-- CreateIndex
CREATE INDEX "EnrichmentProposal_newToElementId_idx" ON "EnrichmentProposal"("newToElementId");

-- CreateIndex
CREATE INDEX "Question_bookId_relationId_createdAt_idx" ON "Question"("bookId", "relationId", "createdAt");

-- AddForeignKey
ALTER TABLE "BibleRelationField" ADD CONSTRAINT "BibleRelationField_workspaceId_relationId_fkey" FOREIGN KEY ("workspaceId", "relationId") REFERENCES "BibleRelation"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BibleRelationVersion" ADD CONSTRAINT "BibleRelationVersion_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BibleRelationVersion" ADD CONSTRAINT "BibleRelationVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "BibleRelation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_newFromElementId_fkey" FOREIGN KEY ("newFromElementId") REFERENCES "BibleElement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_newToElementId_fkey" FOREIGN KEY ("newToElementId") REFERENCES "BibleElement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_bookId_relationId_fkey" FOREIGN KEY ("bookId", "relationId") REFERENCES "BibleRelation"("bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- Row-level security on the two new tables
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "BibleRelationField" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BibleRelationField" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "BibleRelationField";
CREATE POLICY workspace_isolation ON "BibleRelationField"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "BibleRelationField";
CREATE POLICY superuser_bypass ON "BibleRelationField"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "BibleRelationVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BibleRelationVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "BibleRelationVersion";
CREATE POLICY workspace_isolation ON "BibleRelationVersion"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "BibleRelationVersion";
CREATE POLICY superuser_bypass ON "BibleRelationVersion"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- CHECKs
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "BibleRelationField" ADD CONSTRAINT "BibleRelationField_key_shape"
    CHECK ("key" ~ '^[a-z][a-z0-9_]*$' AND char_length("key") <= 64);

ALTER TABLE "BibleRelationVersion" ADD CONSTRAINT "BibleRelationVersion_versionNumber_positive"
    CHECK ("versionNumber" >= 1);
-- An INTERVIEW version names the answers it is drawn from (rule 1); no other
-- version names any. RESEARCH never writes a relation (2.6 proposes no
-- relation), so it is refused here outright.
ALTER TABLE "BibleRelationVersion" ADD CONSTRAINT "BibleRelationVersion_interview_names_answers"
    CHECK (("source" = 'INTERVIEW') = (cardinality(coalesce("sourceAnswerIds", ARRAY[]::text[])) > 0) AND "source" <> 'RESEARCH');

-- The scope's target columns, one shape per scope (the 2.2 CHECK, widened).
ALTER TABLE "InterviewSession" DROP CONSTRAINT "InterviewSession_target_matches_scope";
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_target_matches_scope"
    CHECK (
        ("scope" = 'ELEMENT' AND "targetElementId" IS NOT NULL AND "targetKind" IS NULL)
        OR ("scope" = 'KIND' AND "targetElementId" IS NULL AND "targetKind" IS NOT NULL)
        OR ("scope" = 'BOOK' AND "targetElementId" IS NULL AND "targetKind" IS NULL)
        OR ("scope" IN ('SELECTION', 'BETWEEN') AND "targetElementId" IS NULL AND "targetKind" IS NULL)
    );
-- A SELECTION names at least one element or relation, at most sixty of each
-- (SCOPE_ELEMENTS_MAX, SCOPE_RELATIONS_MAX), no repeats; no other scope names
-- any. A BETWEEN session names its slot (two different neighbours and the
-- kind of the element not yet created); no other scope does.
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_selection_shape"
    CHECK (
        "scopeElementIds" IS NOT NULL AND "scopeRelationIds" IS NOT NULL
        AND (
            ("scope" = 'SELECTION'
                AND cardinality("scopeElementIds") + cardinality("scopeRelationIds") >= 1
                AND cardinality("scopeElementIds") <= 60 AND cardinality("scopeRelationIds") <= 60)
            OR ("scope" <> 'SELECTION' AND cardinality("scopeElementIds") = 0 AND cardinality("scopeRelationIds") = 0)
        )
    );
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_slot_shape"
    CHECK (
        ("scope" = 'BETWEEN'
            AND "slotKind" IS NOT NULL AND "slotAfterElementId" IS NOT NULL AND "slotBeforeElementId" IS NOT NULL
            AND "slotAfterElementId" <> "slotBeforeElementId"
            AND ("slotAct" IS NULL OR ("slotAct" ~ '^[a-z][a-z0-9_]*$' AND char_length("slotAct") <= 64)))
        OR ("scope" <> 'BETWEEN'
            AND "slotKind" IS NULL AND "slotAfterElementId" IS NULL AND "slotBeforeElementId" IS NULL AND "slotAct" IS NULL)
    );

-- A question is about an element, a relation (filed under its declaring
-- element) or the slot's element not yet created (filed under its anchor),
-- never two of them.
ALTER TABLE "Question" ADD CONSTRAINT "Question_one_subject"
    CHECK (NOT ("relationId" IS NOT NULL AND "aboutPending"));

-- One shape per proposal kind (the 2.5 CHECK, widened):
--   FIELD           an element's field, an operation; a REMOVE carries no value
--   RELATION_FIELD  a relation's field, the same; the relation's version (0: none yet)
--   NEW_ELEMENT     a kind and a name; its first field values, or none
--   NEW_RELATION    a type and two ends, each an element or a NEW_ELEMENT
--                   proposal of the session; `{ note, fields }`
ALTER TABLE "EnrichmentProposal" DROP CONSTRAINT "EnrichmentProposal_kind_shape";
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_kind_shape"
    CHECK (
        ("kind" = 'FIELD'
            AND "elementId" IS NOT NULL AND "fieldKey" IS NOT NULL AND "operation" IS NOT NULL AND "baseVersion" IS NOT NULL
            AND "relationId" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND (("operation" = 'REMOVE') = ("proposedValue" IS NULL)))
        OR
        ("kind" = 'RELATION_FIELD'
            AND "relationId" IS NOT NULL AND "fieldKey" IS NOT NULL AND "operation" IS NOT NULL AND "baseVersion" IS NOT NULL
            AND "elementId" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND (("operation" = 'REMOVE') = ("proposedValue" IS NULL)))
        OR
        ("kind" = 'NEW_ELEMENT'
            AND "elementId" IS NULL AND "relationId" IS NULL AND "fieldKey" IS NULL AND "operation" IS NULL AND "baseVersion" IS NULL
            AND "newKind" IS NOT NULL AND "newName" IS NOT NULL AND "versionId" IS NULL)
        OR
        ("kind" = 'NEW_RELATION'
            AND "elementId" IS NULL AND "relationId" IS NULL AND "fieldKey" IS NULL AND "operation" IS NULL AND "baseVersion" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND "proposedValue" IS NOT NULL AND "newRelationType" IS NOT NULL
            AND (("newFromElementId" IS NULL) <> ("newFromProposalId" IS NULL))
            AND (("newToElementId" IS NULL) <> ("newToProposalId" IS NULL)))
    );
-- The NEW_RELATION columns belong to that kind alone; the slot flag to a new element.
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_new_relation_columns"
    CHECK (
        ("kind" = 'NEW_RELATION' OR ("newRelationType" IS NULL AND "newFromElementId" IS NULL AND "newToElementId" IS NULL
            AND "newFromProposalId" IS NULL AND "newToProposalId" IS NULL AND "createdRelationId" IS NULL))
        AND ("kind" = 'NEW_ELEMENT' OR NOT "fillsSlot")
        AND ("newRelationType" IS NULL OR ("newRelationType" ~ '^[a-z][a-z0-9_]*$' AND char_length("newRelationType") <= 64))
        AND ("newFromElementId" IS NULL OR "newFromElementId" <> coalesce("newToElementId", ''))
        AND ("newFromProposalId" IS NULL OR "newFromProposalId" <> coalesce("newToProposalId", ''))
    );
-- A relation field's base may be 0 (a relation saved before 3.3 has no version yet).
ALTER TABLE "EnrichmentProposal" DROP CONSTRAINT "EnrichmentProposal_baseVersion_positive";
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_baseVersion_positive"
    CHECK ("baseVersion" IS NULL OR "baseVersion" >= 1 OR ("kind" = 'RELATION_FIELD' AND "baseVersion" = 0));
-- A decided proposal says when; an accepted one points at what it wrote.
ALTER TABLE "EnrichmentProposal" DROP CONSTRAINT "EnrichmentProposal_decision_shape";
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_decision_shape"
    CHECK (
        ("status" = 'PENDING') = ("decidedAt" IS NULL)
        AND ("status" <> 'PENDING' OR ("decidedById" IS NULL AND "versionId" IS NULL AND "createdElementId" IS NULL AND "createdRelationId" IS NULL))
        AND ("status" NOT IN ('ACCEPTED', 'EDITED_ACCEPTED')
             OR ("kind" IN ('FIELD', 'RELATION_FIELD') AND "versionId" IS NOT NULL)
             OR ("kind" = 'NEW_ELEMENT' AND "createdElementId" IS NOT NULL)
             OR ("kind" = 'NEW_RELATION' AND "createdRelationId" IS NOT NULL AND "versionId" IS NOT NULL))
        AND ("status" IN ('ACCEPTED', 'EDITED_ACCEPTED') OR ("versionId" IS NULL AND "createdElementId" IS NULL AND "createdRelationId" IS NULL))
    );

-- ═══════════════════════════════════════════════════════════════════
-- A proposal's relation and new ends are in the proposal's book
-- ═══════════════════════════════════════════════════════════════════
--
-- As 2.5's element check: the foreign keys are by id alone (Prisma cannot
-- declare an optional composite one beside a required bookId), so this AFTER
-- trigger holds the rest, under the inserting role's row-level security. A
-- NEW_RELATION end that is a proposal must be a NEW_ELEMENT proposal of the
-- same session.

CREATE OR REPLACE FUNCTION enrichment_proposal_relation_in_book() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NEW."relationId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "BibleRelation" WHERE "id" = NEW."relationId" AND "bookId" = NEW."bookId" AND "workspaceId" = NEW."workspaceId"
    ) THEN
        RAISE EXCEPTION 'ENRICHMENT_RELATION_NOT_IN_BOOK: a proposal names a relation outside its book'
            USING ERRCODE = 'P0001';
    END IF;
    IF (NEW."newFromElementId" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "BibleElement" WHERE "id" = NEW."newFromElementId" AND "bookId" = NEW."bookId" AND "workspaceId" = NEW."workspaceId"))
       OR (NEW."newToElementId" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "BibleElement" WHERE "id" = NEW."newToElementId" AND "bookId" = NEW."bookId" AND "workspaceId" = NEW."workspaceId")) THEN
        RAISE EXCEPTION 'ENRICHMENT_ELEMENT_NOT_IN_BOOK: a proposed relation names an element outside its book'
            USING ERRCODE = 'P0001';
    END IF;
    IF (NEW."newFromProposalId" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "EnrichmentProposal" WHERE "id" = NEW."newFromProposalId" AND "sessionId" = NEW."sessionId"
                AND "workspaceId" = NEW."workspaceId" AND "kind" = 'NEW_ELEMENT'))
       OR (NEW."newToProposalId" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "EnrichmentProposal" WHERE "id" = NEW."newToProposalId" AND "sessionId" = NEW."sessionId"
                AND "workspaceId" = NEW."workspaceId" AND "kind" = 'NEW_ELEMENT')) THEN
        RAISE EXCEPTION 'ENRICHMENT_NEW_END_NOT_IN_SESSION: a proposed relation names a proposal that is not a new element of its session'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enrichment_proposal_relation_in_book ON "EnrichmentProposal";
CREATE TRIGGER enrichment_proposal_relation_in_book
    AFTER INSERT OR UPDATE OF "relationId", "newFromElementId", "newToElementId", "newFromProposalId", "newToProposalId", "bookId" ON "EnrichmentProposal"
    FOR EACH ROW EXECUTE FUNCTION enrichment_proposal_relation_in_book();

-- What the model proposed is never rewritten (2.5's trigger): the decision
-- columns now include the relation an accepted NEW_RELATION created.
CREATE OR REPLACE FUNCTION enrichment_proposal_fixed() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    decision_cols text[] := ARRAY['status', 'decidedById', 'decidedAt', 'versionId', 'createdElementId', 'createdRelationId'];
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

-- ═══════════════════════════════════════════════════════════════════
-- BibleRelationVersion is append-only
-- ═══════════════════════════════════════════════════════════════════
--
-- As BibleEntryVersion (the 1.1 migration): app_user reads and inserts; the
-- trigger refuses UPDATE and DELETE (P0001 RELATION_VERSION_APPEND_ONLY) and
-- TRUNCATE for every role, except the delete its book's cascade makes (the
-- book is already gone when the check reads it) and the clearing of
-- `authorId` when that person is deleted. A relation's own deletion leaves
-- its history with the book. Keep the function VOLATILE.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "BibleRelationVersion" FROM app_user;

CREATE OR REPLACE FUNCTION bible_relation_version_append_only() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "Book" WHERE "id" = OLD."bookId") THEN
            RETURN OLD;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD."authorId" IS NOT NULL
           AND NEW."authorId" IS NULL
           AND (to_jsonb(NEW) - 'authorId') = (to_jsonb(OLD) - 'authorId')
           AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."authorId") THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'RELATION_VERSION_APPEND_ONLY: % of BibleRelationVersion refused', TG_OP
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS bible_relation_version_no_update_delete ON "BibleRelationVersion";
CREATE TRIGGER bible_relation_version_no_update_delete
    BEFORE UPDATE OR DELETE ON "BibleRelationVersion"
    FOR EACH ROW EXECUTE FUNCTION bible_relation_version_append_only();

DROP TRIGGER IF EXISTS bible_relation_version_no_truncate ON "BibleRelationVersion";
CREATE TRIGGER bible_relation_version_no_truncate
    BEFORE TRUNCATE ON "BibleRelationVersion"
    FOR EACH STATEMENT EXECUTE FUNCTION bible_relation_version_append_only();
