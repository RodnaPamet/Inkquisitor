-- Phase 3.3 ("Interview from the canvas", decision D24): the new interview
-- scopes and the new proposal kinds.
--
--   InterviewScope.SELECTION          "Grill this": the elements and relations
--                                     selected on a story map
--   InterviewScope.BETWEEN            "What happens between these?": a beat not
--                                     yet created, between two neighbours
--   EnrichmentProposalKind.RELATION_FIELD  a change to one field of a relation
--   EnrichmentProposalKind.NEW_RELATION    a new relation between two elements
--
-- ON THEIR OWN, ON PURPOSE. `ALTER TYPE … ADD VALUE` cannot be used in the
-- transaction that adds it, and Prisma applies a migration file as one
-- transaction; the next migration's CHECKs name the values, so they live in a
-- file of their own that runs after this one commits.
--
-- ROLLING-DEPLOY SAFETY (the 3.2 note, "One deploy"). Additive: no row holds
-- a value until code that knows it writes one; there is no rolling deploy
-- before Phase 7, whose runbook takes a new enum value in two steps.

-- AlterEnum
ALTER TYPE "InterviewScope" ADD VALUE 'SELECTION';
ALTER TYPE "InterviewScope" ADD VALUE 'BETWEEN';

-- AlterEnum
ALTER TYPE "EnrichmentProposalKind" ADD VALUE 'RELATION_FIELD';
ALTER TYPE "EnrichmentProposalKind" ADD VALUE 'NEW_RELATION';
