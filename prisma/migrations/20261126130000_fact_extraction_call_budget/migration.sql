-- Phase 4.1, the owner's answers to the review (2026-11-21; D27 addendum, item 2):
-- one bible fact call's input is bounded and its worst case must fit the per-call
-- cost budget, which is now enforced. A version whose smallest possible call does
-- not fit ends CALL_OVER_BUDGET, nothing sent.

ALTER TABLE "BibleFactExtraction" DROP CONSTRAINT "BibleFactExtraction_outcome_known";
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_outcome_known" CHECK ("outcome" IS NULL OR "outcome" IN (
    'OK', 'NO_CHANGE', 'SUPERSEDED', 'SUBJECT_GONE', 'BOOK_DELETED', 'AUTHOR_NOT_PERMITTED', 'CEILING', 'KILL_SWITCH', 'AI_UNAVAILABLE',
    'NOT_EVALUATED', 'MODEL_RATE_LIMITED', 'GUARD_REFUSED', 'REPEATS_PROMPT', 'CALL_FAILED', 'ABORTED', 'CLAIM_EXPIRED', 'ATTEMPTS_SPENT',
    'CALL_OVER_BUDGET', 'INTERNAL'));
