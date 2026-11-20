-- Phase 2.H item 2: a reconcile run refused because its session's token
-- budget cannot take the call ends REFUSED with the outcome TOKEN_BUDGET
-- (src/lib/enrichment/vocabulary.ts, RECONCILE_OUTCOMES). Nothing was sent.
-- The two CHECKs of 20261120000000_enrichment are widened by that one code.
ALTER TABLE "ReconcileRun" DROP CONSTRAINT "ReconcileRun_outcome_known";
ALTER TABLE "ReconcileRun" ADD CONSTRAINT "ReconcileRun_outcome_known"
    CHECK ("outcome" IS NULL OR "outcome" IN (
        'OK', 'NOTHING_TO_RECONCILE', 'GUARD_REFUSED', 'TIMEOUT', 'ABORTED', 'PROVIDER_FAILURE',
        'INVALID_OUTPUT', 'KILL_SWITCH', 'WORKSPACE_CEILING', 'PROMPT_INVALID', 'AI_UNAVAILABLE',
        'RECONCILE_NOT_EVALUATED', 'CLAIM_EXPIRED', 'TOKEN_BUDGET'));
ALTER TABLE "ReconcileRun" DROP CONSTRAINT "ReconcileRun_outcome_with_status";
ALTER TABLE "ReconcileRun" ADD CONSTRAINT "ReconcileRun_outcome_with_status"
    CHECK (("status" = 'RUNNING') = ("outcome" IS NULL)
       AND ("status" = 'RUNNING') = ("finishedAt" IS NULL)
       AND ("status" <> 'DONE' OR "outcome" IN ('OK', 'NOTHING_TO_RECONCILE'))
       AND ("status" <> 'REFUSED' OR "outcome" IN ('AI_UNAVAILABLE', 'RECONCILE_NOT_EVALUATED', 'TOKEN_BUDGET')));
