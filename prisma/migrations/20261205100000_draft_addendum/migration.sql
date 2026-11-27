-- Phase 5.3 — the owner's three decisions of 2026-11-27 (D35 addendum A, B and C).
--
--   A  ContinuitySettings     a book's continuity settings: `deepReadsDraft`, off by default — the nightly deep check
--                             also reads the book's live DRAFT facts and may raise draft-vs-bible mismatches (basis
--                             DRAFT, naming the continuity run that found them in `checkRunId`, never a draft run)
--   B  (no schema)            the nightly share's halves are measured from the ledger and the run rows already held
--   C  StoryFactProposal      `settleReason`: how a draft mismatch settled by itself (DRAFT_CHANGED: a re-read no longer
--                             finds the claim; BIBLE_GONE: its bible fact no longer stands), set with `settledAt`, which
--                             an INVALIDATED draft mismatch now carries too — the "Recently resolved" list reads both
--
-- The new table is workspace-scoped (FORCE RLS, `workspace_isolation`, `superuser_bypass`) and goes with its book.

-- AlterTable
ALTER TABLE "StoryFactProposal" ADD COLUMN     "settleReason" TEXT;

-- CreateTable
CREATE TABLE "ContinuitySettings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "deepReadsDraft" BOOLEAN NOT NULL DEFAULT false,
    "deepReadsDraftSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContinuitySettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContinuitySettings_workspaceId_bookId_key" ON "ContinuitySettings"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "StoryFactProposal_workspaceId_bookId_basis_settledAt_idx" ON "StoryFactProposal"("workspaceId", "bookId", "basis", "settledAt");

-- AddForeignKey
ALTER TABLE "ContinuitySettings" ADD CONSTRAINT "ContinuitySettings_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- On, it names when it was turned on (the deep check counts the draft facts already read as new from then); off, never.
ALTER TABLE "ContinuitySettings" ADD CONSTRAINT "ContinuitySettings_on_since" CHECK ("deepReadsDraft" = ("deepReadsDraftSince" IS NOT NULL));

-- ─── C: how a draft mismatch settled ─────────────────────────────────────
-- Rows settled before this column existed: a FIXED one is taken as the draft having changed, an INVALIDATED one (its
-- bible fact set aside or retracted) gains its settlement time from its decision. The write-once trigger would refuse
-- the second (a decided row's `settledAt` never moves), so it is held off for these two statements alone.
ALTER TABLE "StoryFactProposal" DISABLE TRIGGER story_fact_proposal_fixed;
UPDATE "StoryFactProposal" SET "settleReason" = 'DRAFT_CHANGED' WHERE "basis" = 'DRAFT' AND "status" = 'FIXED' AND "settleReason" IS NULL;
UPDATE "StoryFactProposal" SET "settledAt" = "decidedAt", "settleReason" = 'BIBLE_GONE' WHERE "basis" = 'DRAFT' AND "status" = 'INVALIDATED' AND "settledAt" IS NULL;
ALTER TABLE "StoryFactProposal" ENABLE TRIGGER story_fact_proposal_fixed;

-- 5.3's CHECK (20261204110000), widened twice: a DRAFT proposal names the run that raised it — a draft run (the rule
-- path) or a continuity run (the deep check, addendum A), exactly one; and a draft mismatch that settled by itself
-- (FIXED, or INVALIDATED because its bible fact went) carries `settledAt` and its `settleReason`, nothing else does.
ALTER TABLE "StoryFactProposal" DROP CONSTRAINT "StoryFactProposal_known";
ALTER TABLE "StoryFactProposal" ADD CONSTRAINT "StoryFactProposal_known" CHECK (
    "status" IN ('PENDING', 'INVALIDATED', 'INVALIDATED_NEWER', 'KEPT', 'REJECTED', 'FIX_PENDING', 'FIXED', 'BIBLE_UPDATED')
    AND (
        ("basis" <> 'DRAFT'
            AND "status" NOT IN ('FIX_PENDING', 'FIXED', 'BIBLE_UPDATED')
            AND "sceneId" IS NULL AND "draftClaimKey" IS NULL AND "draftRunId" IS NULL AND "settledAt" IS NULL AND "settleReason" IS NULL
            AND (("reason" = 'CONTRADICTED' AND "basis" IN ('RULE', 'MODEL', 'DEEP') AND "newerFactId" IS NOT NULL
                  AND "kind" IN ('VALUE', 'WHEREABOUTS', 'KNOWLEDGE', 'TIMELINE', 'OTHER'))
              OR ("reason" = 'NO_LONGER_STATED' AND "basis" = 'TEXT' AND "newerFactId" IS NULL AND "kind" IS NULL AND "status" <> 'INVALIDATED_NEWER')))
        OR
        ("basis" = 'DRAFT' AND "reason" = 'CONTRADICTED' AND "newerFactId" IS NOT NULL
            AND "kind" IN ('VALUE', 'WHEREABOUTS', 'KNOWLEDGE', 'TIMELINE', 'OTHER')
            AND "status" IN ('PENDING', 'FIX_PENDING', 'FIXED', 'BIBLE_UPDATED', 'KEPT', 'INVALIDATED')
            AND "sceneId" IS NOT NULL AND "draftClaimKey" ~ '^[0-9a-f]{64}$'
            AND ("status" IN ('FIXED', 'INVALIDATED')) = ("settledAt" IS NOT NULL)
            AND ("settledAt" IS NULL) = ("settleReason" IS NULL)
            AND ("settleReason" IS NULL OR "settleReason" IN ('DRAFT_CHANGED', 'BIBLE_GONE'))
            AND ("status" <> 'INVALIDATED' OR "settleReason" = 'BIBLE_GONE')
            AND "extractionId" IS NULL
            AND ("checkRunId" IS NULL) <> ("draftRunId" IS NULL))
    )
    AND ("newerFactId" IS NULL OR "newerFactId" <> "factId")
    AND (("status" = 'PENDING') = ("decidedAt" IS NULL))
    AND ("basis" <> 'DEEP' OR "checkRunId" IS NOT NULL)
);

-- 5.3's function (20261204110000), `settleReason` fixed with `settledAt`: written once, in the move that settles the
-- mismatch (PENDING → FIXED / INVALIDATED, or FIX_PENDING → FIXED), and never after.
CREATE OR REPLACE FUNCTION story_fact_proposal_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."bookId" IS DISTINCT FROM OLD."bookId"
       OR NEW."factId" IS DISTINCT FROM OLD."factId" OR NEW."newerFactId" IS DISTINCT FROM OLD."newerFactId"
       OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."basis" IS DISTINCT FROM OLD."basis"
       OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."checkRunId" IS DISTINCT FROM OLD."checkRunId"
       OR NEW."extractionId" IS DISTINCT FROM OLD."extractionId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."sceneId" IS DISTINCT FROM OLD."sceneId" OR NEW."draftClaimKey" IS DISTINCT FROM OLD."draftClaimKey"
       OR NEW."draftRunId" IS DISTINCT FROM OLD."draftRunId"
       OR (OLD."settledAt" IS NOT NULL AND NEW."settledAt" IS DISTINCT FROM OLD."settledAt")
       OR (OLD."settleReason" IS NOT NULL AND NEW."settleReason" IS DISTINCT FROM OLD."settleReason") THEN
        RAISE EXCEPTION 'STORY_FACT_PROPOSAL_FIXED: only a pending proposal''s decision may be written, once' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."status" = 'FIX_PENDING' AND NEW."status" = 'FIXED' THEN
        IF NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt" OR NEW."decidedById" IS DISTINCT FROM OLD."decidedById" OR NEW."settledAt" IS NULL THEN
            RAISE EXCEPTION 'STORY_FACT_PROPOSAL_FIXED: settling a fix keeps its decision' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."status" <> 'PENDING' AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
           OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt" OR NEW."settleReason" IS DISTINCT FROM OLD."settleReason"
           OR (NEW."decidedById" IS NOT NULL AND NEW."decidedById" IS DISTINCT FROM OLD."decidedById")) THEN
        RAISE EXCEPTION 'STORY_FACT_PROPOSAL_FIXED: only a pending proposal''s decision may be written, once' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "ContinuitySettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContinuitySettings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ContinuitySettings";
CREATE POLICY workspace_isolation ON "ContinuitySettings"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ContinuitySettings";
CREATE POLICY superuser_bypass ON "ContinuitySettings"
    USING (current_setting('role') != 'app_user');
