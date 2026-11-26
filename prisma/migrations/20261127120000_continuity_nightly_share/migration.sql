-- Phase 4.2 — the D28 addendum, item 1: a per-workspace NIGHTLY SHARE of the month for the deep continuity check.
--
--   AiSpendReservation.purpose   the purpose of the call a live reservation holds (2.1's `template.purpose`), so the
--                                ledger can count what calls of ONE purpose have charged and still hold, under the same
--                                per-workspace spend lock as the month's check: the nightly share holds across books
--                                and concurrent jobs. NULL for a reservation made before the column.
--   ContinuityRun                a night stopped at the share: NIGHTLY_CAP (resumable, never a failure).

-- AlterTable
ALTER TABLE "AiSpendReservation" ADD COLUMN "purpose" TEXT;

ALTER TABLE "ContinuityRun" DROP CONSTRAINT "ContinuityRun_outcome_known";
ALTER TABLE "ContinuityRun" ADD CONSTRAINT "ContinuityRun_outcome_known" CHECK ("outcome" IS NULL OR "outcome" IN (
    'OK', 'PAGED', 'NO_FACTS', 'NOTHING_NEW', 'BOOK_DELETED', 'NO_ACTOR', 'CEILING', 'NIGHTLY_CAP', 'KILL_SWITCH', 'AI_UNAVAILABLE',
    'NOT_EVALUATED', 'MODEL_RATE_LIMITED', 'CALL_FAILED', 'GUARD_REFUSED', 'CALL_OVER_BUDGET', 'ABORTED', 'CLAIM_EXPIRED', 'INTERNAL'));
