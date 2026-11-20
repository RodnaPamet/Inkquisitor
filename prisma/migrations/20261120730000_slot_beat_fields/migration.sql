-- Phase 3.H, owner decision of 2026-11-20 (D25, "keep going on the new beat"):
-- a "What happens between these?" session goes on asking about the beat it
-- proposed, and reconcile proposes that beat's further fields as FIELD
-- proposals that wait for it.
--
-- `targetProposalId` names the slot's NEW_ELEMENT proposal of the same
-- session (the beat, not yet an element) that a FIELD proposal fills. Such a
-- proposal has no `elementId` and no `baseVersion` (there was no element to
-- read a version of) and only ever ADDs: it fills a field the beat does not
-- hold. Accepting it waits for the beat's acceptance (409 END_NOT_CREATED) and
-- writes to the element that acceptance created; a rejected beat, or one whose
-- element is gone, refuses it (409 END_GONE). No foreign key, as for a new
-- relation's proposed ends: the trigger below holds it to its session.

ALTER TABLE "EnrichmentProposal" ADD COLUMN "targetProposalId" TEXT;

CREATE INDEX "EnrichmentProposal_targetProposalId_fieldKey_idx" ON "EnrichmentProposal"("targetProposalId", "fieldKey");

-- One shape per proposal kind (the 3.3 CHECK, FIELD widened): an element's
-- field with its version, or the slot's beat's field, ADD only.
ALTER TABLE "EnrichmentProposal" DROP CONSTRAINT "EnrichmentProposal_kind_shape";
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_kind_shape"
    CHECK (
        ("kind" = 'FIELD'
            AND "fieldKey" IS NOT NULL AND "operation" IS NOT NULL
            AND (("elementId" IS NOT NULL AND "targetProposalId" IS NULL AND "baseVersion" IS NOT NULL)
                 OR ("elementId" IS NULL AND "targetProposalId" IS NOT NULL AND "baseVersion" IS NULL AND "operation" = 'ADD'))
            AND "relationId" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND (("operation" = 'REMOVE') = ("proposedValue" IS NULL)))
        OR
        ("kind" = 'RELATION_FIELD'
            AND "relationId" IS NOT NULL AND "fieldKey" IS NOT NULL AND "operation" IS NOT NULL AND "baseVersion" IS NOT NULL
            AND "elementId" IS NULL AND "targetProposalId" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND (("operation" = 'REMOVE') = ("proposedValue" IS NULL)))
        OR
        ("kind" = 'NEW_ELEMENT'
            AND "elementId" IS NULL AND "relationId" IS NULL AND "fieldKey" IS NULL AND "operation" IS NULL AND "baseVersion" IS NULL
            AND "targetProposalId" IS NULL
            AND "newKind" IS NOT NULL AND "newName" IS NOT NULL AND "versionId" IS NULL)
        OR
        ("kind" = 'NEW_RELATION'
            AND "elementId" IS NULL AND "relationId" IS NULL AND "fieldKey" IS NULL AND "operation" IS NULL AND "baseVersion" IS NULL
            AND "targetProposalId" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND "proposedValue" IS NOT NULL AND "newRelationType" IS NOT NULL
            AND (("newFromElementId" IS NULL) <> ("newFromProposalId" IS NULL))
            AND (("newToElementId" IS NULL) <> ("newToProposalId" IS NULL)))
    );

-- A proposal's relation, new ends and (now) target beat are in the proposal's
-- book and session (the 3.3 trigger, one check added): a FIELD proposal's
-- target is a NEW_ELEMENT proposal of the same session that fills its slot.
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
    IF NEW."targetProposalId" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "EnrichmentProposal" WHERE "id" = NEW."targetProposalId" AND "sessionId" = NEW."sessionId"
                AND "workspaceId" = NEW."workspaceId" AND "kind" = 'NEW_ELEMENT' AND "fillsSlot") THEN
        RAISE EXCEPTION 'ENRICHMENT_TARGET_NOT_SLOT_BEAT: a field proposal names a proposal that is not its session''s slot beat'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enrichment_proposal_relation_in_book ON "EnrichmentProposal";
CREATE TRIGGER enrichment_proposal_relation_in_book
    AFTER INSERT OR UPDATE OF "relationId", "newFromElementId", "newToElementId", "newFromProposalId", "newToProposalId", "targetProposalId", "bookId" ON "EnrichmentProposal"
    FOR EACH ROW EXECUTE FUNCTION enrichment_proposal_relation_in_book();
