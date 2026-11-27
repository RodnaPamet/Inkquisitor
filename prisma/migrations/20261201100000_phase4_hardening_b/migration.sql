-- Phase 4.H-b: hardening Phase 4 — scale and evaluation (decisions D31, D32).
--
--   BibleFactExtraction.origin        SAVE (the outbox trigger) | BACKFILL (the backfill of an entry saved before 4.1:
--                                     its newest version, written by the `fact-backfill` job). The minutely dispatcher
--                                     queues SAVE rows only; the backfill queues its own under the daily share (D32).
--   BibleFactExtraction.guardRefused  the sections the guard refused and the guard rule version that refused each
--                                     (D32): re-sent once when the guard's version is newer. Section keys and numbers.
--   outcome DAILY_SHARE               a backfill extraction stopped at the workspace's daily share (resumable).
--   outcome MONTHLY_SHARE             a backfill extraction stopped at its share of the calendar month (resumable;
--                                     owner decision 2026-11-27, D32).
--   ContinuityCheck.passedOver(Cut)   the subjects the nightly check passed over, remembered (D32), ids only.
--   JobCursor                         where a multi-workspace discovery stopped (#60.4); GLOBAL, ids only, no grant.
--   StoryFactProposal index           a book's pending proposals of one reason (the Continuity page, item 6).
--   bible_entry_version_stale_flags   rewrites a flag only when its state changes (#62.2): an autosave of a heavily
--                                     cited element no longer rewrites every standing OPEN flag it already raised.

-- ─── The extraction outbox ─────────────────────────────────────────

ALTER TABLE "BibleFactExtraction" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'SAVE';
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_origin_known" CHECK ("origin" IN ('SAVE', 'BACKFILL'));
ALTER TABLE "BibleFactExtraction" ADD COLUMN "guardRefused" JSONB;
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_guard_refused_shape" CHECK ("guardRefused" IS NULL OR jsonb_typeof("guardRefused") = 'array');

ALTER TABLE "BibleFactExtraction" DROP CONSTRAINT "BibleFactExtraction_outcome_known";
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_outcome_known" CHECK ("outcome" IS NULL OR "outcome" IN (
    'OK', 'NO_CHANGE', 'SUPERSEDED', 'SUBJECT_GONE', 'BOOK_DELETED', 'AUTHOR_NOT_PERMITTED', 'CEILING', 'KILL_SWITCH', 'AI_UNAVAILABLE',
    'NOT_EVALUATED', 'MODEL_RATE_LIMITED', 'GUARD_REFUSED', 'REPEATS_PROMPT', 'CALL_FAILED', 'ABORTED', 'CLAIM_EXPIRED', 'ATTEMPTS_SPENT',
    'CALL_OVER_BUDGET', 'INTERNAL', 'DAILY_SHARE', 'MONTHLY_SHARE'));

DROP INDEX "BibleFactExtraction_status_createdAt_idx";
CREATE INDEX "BibleFactExtraction_origin_status_createdAt_idx" ON "BibleFactExtraction"("origin", "status", "createdAt");
CREATE INDEX "BibleFactExtraction_origin_workspaceId_status_idx" ON "BibleFactExtraction"("origin", "workspaceId", "status");

-- ─── The nightly check remembers what it passed over ───────────────

ALTER TABLE "ContinuityCheck" ADD COLUMN "passedOver" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ContinuityCheck" ADD COLUMN "passedOverCut" BOOLEAN NOT NULL DEFAULT false;
-- Order keys only (`KIND:id`), bounded (`CONTINUITY_PASSED_OVER_MAX`, 500).
ALTER TABLE "ContinuityCheck" ADD CONSTRAINT "ContinuityCheck_passed_over_bounded" CHECK (cardinality("passedOver") <= 500);

-- ─── A multi-workspace discovery's cursor (#60.4) ──────────────────

CREATE TABLE "JobCursor" (
    "name" TEXT NOT NULL,
    "cursor" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobCursor_pkey" PRIMARY KEY ("name")
);
ALTER TABLE "JobCursor" ADD CONSTRAINT "JobCursor_ids_only" CHECK ("name" ~ '^[a-z][a-z0-9:-]{0,63}$' AND "cursor" ~ '^[A-Za-z0-9_-]{0,64}$');
-- GLOBAL (`GLOBAL_MODELS`): reached only through `runWithoutRls` by a discovery; app_user holds no grant.
REVOKE ALL ON TABLE "JobCursor" FROM app_user;

-- ─── The Continuity page at scale (roadmap 4.H item 6) ─────────────

CREATE INDEX "StoryFactProposal_workspaceId_bookId_status_reason_createdA_idx" ON "StoryFactProposal"("workspaceId", "bookId", "status", "reason", "createdAt");

-- ─── Propagation debt: rewrite a flag only when its state changes (#62.2) ───
--
-- 4.2's raise wrote every citing entry's flag on EVERY save of the element (ON CONFLICT DO UPDATE, up to 500 rows a
-- save, each through `stale_flag_guard`), so an autosave of a heavily cited element rewrote hundreds of unchanged
-- rows in the save's transaction. A flag that is OPEN and still STANDING (its entry not saved since it was raised)
-- already says what this save would say: the debt began at its base version, and the change runs to the upstream as
-- it stands now, which the readers read off the upstream element itself. Such a row is now left alone (`ON CONFLICT
-- … DO UPDATE … WHERE`: no new tuple, no guard trigger); only a flag that is DISMISSED, CLEARED, or OPEN but cleared by
-- a save of its entry is raised again, with this change as its base. Everything else is as 4.2 wrote it.
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
        "baseVersionId" = EXCLUDED."baseVersionId",
        "downstreamVersionNumber" = EXCLUDED."downstreamVersionNumber",
        "status" = 'OPEN',
        "raisedAt" = now(),
        "dismissedAt" = NULL,
        "dismissedById" = NULL
    WHERE NOT ("StaleFlag"."status" = 'OPEN' AND NOT EXISTS (
        SELECT 1 FROM "BibleEntryVersion" w WHERE w."elementId" = "StaleFlag"."elementId"
          AND w."versionNumber" > "StaleFlag"."downstreamVersionNumber" AND NOT w."movedInOrder"));
    RETURN NULL;
END
$$;
