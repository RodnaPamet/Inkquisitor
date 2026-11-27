-- Phase 5.3 — the draft held against the bible (decisions D3 and D35).
--
--   • DRAFT FACTS are StoryFacts of kind SCENE_TEXT (the one fact table, 4.1): read from a manuscript scene by the
--     nightly pass, never canon (PENDING, never decided, never an answer to a field, never embedded), each naming its
--     scene and the keyed hash of the text read; they go with their scene.
--   • DRAFT MISMATCHES are StoryFactProposals of basis DRAFT (never a second contradiction table): the bible fact is
--     the older side, the draft fact the newer; the author decides FIX_DRAFT (FIX_PENDING, settled FIXED by a re-read
--     that no longer finds the claim), UPDATE_BIBLE (BIBLE_UPDATED, written by the author's own versioned save of the
--     field, source MANUSCRIPT naming the scene) or BOTH_TRUE (KEPT, the explanation an AUTHOR_RESOLUTION fact).
--   • SceneDraftRead (a scene's cursor), DraftReadRun (one a book a night), StoryThreadSceneLink (a thread planted or
--     paid off by a scene: proposed, decided once), SceneCard / SceneCardVersion (a scene's card, append-only history).
--   • A scene interview (InterviewSession.scope SCENE, its scene) asks about the card; its questions are filed under a
--     carrier element with the scene named; a SCENE_CARD_FIELD proposal changes a card field, never the prose (D3).

-- AlterTable
ALTER TABLE "BibleEntryVersion" ADD COLUMN     "sourceSceneId" TEXT;
ALTER TABLE "EnrichmentProposal" ADD COLUMN     "sceneId" TEXT;
ALTER TABLE "InterviewSession" ADD COLUMN     "sceneId" TEXT;
ALTER TABLE "Question" ADD COLUMN     "sceneId" TEXT;
ALTER TABLE "StoryFact" ADD COLUMN     "sceneId" TEXT,
ADD COLUMN     "sceneTextKey" TEXT;
ALTER TABLE "StoryFactProposal" ADD COLUMN     "draftClaimKey" TEXT,
ADD COLUMN     "draftRunId" TEXT,
ADD COLUMN     "sceneId" TEXT,
ADD COLUMN     "settledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SceneDraftRead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "textKey" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "textCut" BOOLEAN NOT NULL DEFAULT false,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "factsKept" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneDraftRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftReadRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "nightKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "outcome" TEXT,
    "scenesRead" INTEGER NOT NULL DEFAULT 0,
    "scenesRemaining" INTEGER NOT NULL DEFAULT 0,
    "factsKept" INTEGER NOT NULL DEFAULT 0,
    "mismatchesRaised" INTEGER NOT NULL DEFAULT 0,
    "mismatchesFixed" INTEGER NOT NULL DEFAULT 0,
    "linksProposed" INTEGER NOT NULL DEFAULT 0,
    "callsMade" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "promptVersion" TEXT,
    "metrics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DraftReadRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryThreadSceneLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "quoteStart" INTEGER NOT NULL,
    "quoteEnd" INTEGER NOT NULL,
    "sceneTextKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "runId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryThreadSceneLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneCard" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "goal" TEXT,
    "conflict" TEXT,
    "outcome" TEXT,
    "change" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SceneCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneCardVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "source" "BibleVersionSource" NOT NULL,
    "sourceAnswerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneCardVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SceneDraftRead_workspaceId_bookId_sceneId_key" ON "SceneDraftRead"("workspaceId", "bookId", "sceneId");
CREATE UNIQUE INDEX "SceneDraftRead_workspaceId_id_key" ON "SceneDraftRead"("workspaceId", "id");
CREATE INDEX "DraftReadRun_workspaceId_bookId_createdAt_idx" ON "DraftReadRun"("workspaceId", "bookId", "createdAt");
CREATE INDEX "DraftReadRun_status_createdAt_idx" ON "DraftReadRun"("status", "createdAt");
CREATE UNIQUE INDEX "DraftReadRun_workspaceId_bookId_nightKey_key" ON "DraftReadRun"("workspaceId", "bookId", "nightKey");
CREATE UNIQUE INDEX "DraftReadRun_workspaceId_id_key" ON "DraftReadRun"("workspaceId", "id");
CREATE INDEX "StoryThreadSceneLink_workspaceId_bookId_status_createdAt_idx" ON "StoryThreadSceneLink"("workspaceId", "bookId", "status", "createdAt");
CREATE INDEX "StoryThreadSceneLink_workspaceId_bookId_sceneId_idx" ON "StoryThreadSceneLink"("workspaceId", "bookId", "sceneId");
CREATE INDEX "StoryThreadSceneLink_decidedById_idx" ON "StoryThreadSceneLink"("decidedById");
CREATE UNIQUE INDEX "StoryThreadSceneLink_workspaceId_threadId_sceneId_role_key" ON "StoryThreadSceneLink"("workspaceId", "threadId", "sceneId", "role");
CREATE UNIQUE INDEX "StoryThreadSceneLink_workspaceId_id_key" ON "StoryThreadSceneLink"("workspaceId", "id");
CREATE UNIQUE INDEX "SceneCard_workspaceId_bookId_sceneId_key" ON "SceneCard"("workspaceId", "bookId", "sceneId");
CREATE UNIQUE INDEX "SceneCard_workspaceId_id_key" ON "SceneCard"("workspaceId", "id");
CREATE INDEX "SceneCardVersion_workspaceId_bookId_idx" ON "SceneCardVersion"("workspaceId", "bookId");
CREATE INDEX "SceneCardVersion_authorId_idx" ON "SceneCardVersion"("authorId");
CREATE UNIQUE INDEX "SceneCardVersion_sceneId_versionNumber_key" ON "SceneCardVersion"("sceneId", "versionNumber");
CREATE INDEX "EnrichmentProposal_workspaceId_bookId_sceneId_idx" ON "EnrichmentProposal"("workspaceId", "bookId", "sceneId");
CREATE INDEX "InterviewSession_workspaceId_bookId_sceneId_idx" ON "InterviewSession"("workspaceId", "bookId", "sceneId");
CREATE INDEX "Question_workspaceId_bookId_sceneId_idx" ON "Question"("workspaceId", "bookId", "sceneId");
CREATE INDEX "StoryFact_workspaceId_bookId_sceneId_supersededAt_idx" ON "StoryFact"("workspaceId", "bookId", "sceneId", "supersededAt");
CREATE INDEX "StoryFactProposal_workspaceId_bookId_basis_status_createdAt_idx" ON "StoryFactProposal"("workspaceId", "bookId", "basis", "status", "createdAt");
CREATE INDEX "StoryFactProposal_workspaceId_bookId_sceneId_status_idx" ON "StoryFactProposal"("workspaceId", "bookId", "sceneId", "status");

-- AddForeignKey
ALTER TABLE "SceneDraftRead" ADD CONSTRAINT "SceneDraftRead_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftReadRun" ADD CONSTRAINT "DraftReadRun_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryThreadSceneLink" ADD CONSTRAINT "StoryThreadSceneLink_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryThreadSceneLink" ADD CONSTRAINT "StoryThreadSceneLink_workspaceId_threadId_fkey" FOREIGN KEY ("workspaceId", "threadId") REFERENCES "StoryThread"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryThreadSceneLink" ADD CONSTRAINT "StoryThreadSceneLink_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryThreadSceneLink" ADD CONSTRAINT "StoryThreadSceneLink_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SceneCard" ADD CONSTRAINT "SceneCard_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SceneCardVersion" ADD CONSTRAINT "SceneCardVersion_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SceneCardVersion" ADD CONSTRAINT "SceneCardVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Question" ADD CONSTRAINT "Question_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryFactProposal" ADD CONSTRAINT "StoryFactProposal_workspaceId_bookId_sceneId_fkey" FOREIGN KEY ("workspaceId", "bookId", "sceneId") REFERENCES "ManuscriptScene"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── StoryFact: a draft fact is a fifth kind ───────────────────────────
-- Never canon: PENDING and never decided (no decider, no answer, no carry, no resolution, never invalidated by another
-- fact); automatic, keyed by its claim within its scene; naming its scene and the keyed hash of the text read.
ALTER TABLE "StoryFact" DROP CONSTRAINT "StoryFact_kind_columns";
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_kind_columns" CHECK (
    CASE "sourceKind"::text
        WHEN 'SOURCE_CHUNK' THEN "sourceId" IS NOT NULL AND "chunkId" IS NOT NULL AND "bookId" IS NULL AND "elementId" IS NULL
            AND "relationId" IS NULL AND "bibleVersionId" IS NULL AND "relationVersionId" IS NULL AND NOT "automatic" AND "dedupeKey" IS NULL
            AND "resolvesProposalId" IS NULL AND "sceneId" IS NULL AND "sceneTextKey" IS NULL
        WHEN 'BIBLE_VERSION' THEN "sourceId" IS NULL AND "chunkId" IS NULL AND "bookId" IS NOT NULL AND "elementId" IS NOT NULL
            AND "relationId" IS NULL AND "bibleVersionId" IS NOT NULL AND "relationVersionId" IS NULL AND "automatic"
            AND "dedupeKey" IS NOT NULL AND "status" = 'CONFIRMED' AND "carriedFromFactId" IS NULL AND "resolvesProposalId" IS NULL
            AND "sceneId" IS NULL AND "sceneTextKey" IS NULL
        WHEN 'RELATION_VERSION' THEN "sourceId" IS NULL AND "chunkId" IS NULL AND "bookId" IS NOT NULL AND "elementId" IS NULL
            AND "relationId" IS NOT NULL AND "bibleVersionId" IS NULL AND "relationVersionId" IS NOT NULL AND "automatic"
            AND "dedupeKey" IS NOT NULL AND "status" = 'CONFIRMED' AND "carriedFromFactId" IS NULL AND "resolvesProposalId" IS NULL
            AND "sceneId" IS NULL AND "sceneTextKey" IS NULL
        WHEN 'AUTHOR_RESOLUTION' THEN "sourceId" IS NULL AND "chunkId" IS NULL AND "bookId" IS NOT NULL AND "elementId" IS NULL
            AND "relationId" IS NULL AND "bibleVersionId" IS NULL AND "relationVersionId" IS NULL AND NOT "automatic"
            AND "dedupeKey" IS NULL AND "status" = 'CONFIRMED' AND "carriedFromFactId" IS NULL AND "resolvesProposalId" IS NOT NULL
            AND "decidedById" IS NOT NULL AND "sceneId" IS NULL AND "sceneTextKey" IS NULL
        WHEN 'SCENE_TEXT' THEN "sourceId" IS NULL AND "chunkId" IS NULL AND "bookId" IS NOT NULL AND "elementId" IS NULL
            AND "relationId" IS NULL AND "bibleVersionId" IS NULL AND "relationVersionId" IS NULL AND "automatic"
            AND "dedupeKey" IS NOT NULL AND "status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL
            AND "decidedByAnswerId" IS NULL AND "carriedFromFactId" IS NULL AND "resolvesProposalId" IS NULL
            AND "invalidatedByFactId" IS NULL
            AND "sceneId" IS NOT NULL AND "sceneTextKey" ~ '^[0-9a-f]{64}$'
        ELSE false
    END
);

-- 4.4's function (20261129110000), the scene and its text key added to what never changes.
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
       OR NEW."sceneId" IS DISTINCT FROM OLD."sceneId" OR NEW."sceneTextKey" IS DISTINCT FROM OLD."sceneTextKey"
       OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt")
       OR (NEW."invalidatedByFactId" IS NOT NULL AND NEW."invalidatedByFactId" IS DISTINCT FROM OLD."invalidatedByFactId" AND OLD."supersededAt" IS NOT NULL)
       OR (NEW."invalidatedByFactId" IS NULL AND OLD."invalidatedByFactId" IS NOT NULL
           AND EXISTS (SELECT 1 FROM "StoryFact" n WHERE n."id" = OLD."invalidatedByFactId"))
       OR (NEW."subjectElementId" IS NOT NULL AND NEW."subjectElementId" IS DISTINCT FROM OLD."subjectElementId")
       OR (NEW."objectElementId" IS NOT NULL AND NEW."objectElementId" IS DISTINCT FROM OLD."objectElementId")
       OR (NEW."decidedByAnswerId" IS NOT NULL AND NEW."decidedByAnswerId" IS DISTINCT FROM OLD."decidedByAnswerId"
           AND (OLD."status" <> 'PENDING' OR NEW."status" = 'PENDING' OR cardinality(OLD."flags") > 0)) THEN
        RAISE EXCEPTION 'STORY_FACT_FIXED: only a fact''s decision may change' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;

-- A draft fact is never embedded: it is not canon, and the retriever's vectors are the canon's (4.1). The trigger of
-- 4.1 (20261126110000), now asked only of the other kinds.
DROP TRIGGER IF EXISTS story_fact_embedding_task ON "StoryFact";
CREATE TRIGGER story_fact_embedding_task AFTER INSERT ON "StoryFact" FOR EACH ROW
    WHEN (NEW."sourceKind"::text <> 'SCENE_TEXT')
    EXECUTE FUNCTION story_embedding_task('StoryFact');

-- ─── StoryFactProposal: a draft mismatch is basis DRAFT ──────────────────
-- 4.2's CHECK, widened. A DRAFT proposal is a contradiction between a bible fact (the older) and a draft fact (the
-- newer), naming its scene and the draft claim's keyed hash; its decisions are its own: FIX_PENDING (the author will
-- fix the draft), FIXED (a re-read no longer finds the claim: `settledAt`), BIBLE_UPDATED (the author's own save of
-- the field), KEPT (both true, explained) and INVALIDATED (the bible fact was set aside meanwhile, 4.2's settling).
-- No other basis takes those three statuses or any draft column.
ALTER TABLE "StoryFactProposal" DROP CONSTRAINT "StoryFactProposal_known";
ALTER TABLE "StoryFactProposal" ADD CONSTRAINT "StoryFactProposal_known" CHECK (
    "status" IN ('PENDING', 'INVALIDATED', 'INVALIDATED_NEWER', 'KEPT', 'REJECTED', 'FIX_PENDING', 'FIXED', 'BIBLE_UPDATED')
    AND (
        ("basis" <> 'DRAFT'
            AND "status" NOT IN ('FIX_PENDING', 'FIXED', 'BIBLE_UPDATED')
            AND "sceneId" IS NULL AND "draftClaimKey" IS NULL AND "draftRunId" IS NULL AND "settledAt" IS NULL
            AND (("reason" = 'CONTRADICTED' AND "basis" IN ('RULE', 'MODEL', 'DEEP') AND "newerFactId" IS NOT NULL
                  AND "kind" IN ('VALUE', 'WHEREABOUTS', 'KNOWLEDGE', 'TIMELINE', 'OTHER'))
              OR ("reason" = 'NO_LONGER_STATED' AND "basis" = 'TEXT' AND "newerFactId" IS NULL AND "kind" IS NULL AND "status" <> 'INVALIDATED_NEWER')))
        OR
        ("basis" = 'DRAFT' AND "reason" = 'CONTRADICTED' AND "newerFactId" IS NOT NULL
            AND "kind" IN ('VALUE', 'WHEREABOUTS', 'KNOWLEDGE', 'TIMELINE', 'OTHER')
            AND "status" IN ('PENDING', 'FIX_PENDING', 'FIXED', 'BIBLE_UPDATED', 'KEPT', 'INVALIDATED')
            AND "sceneId" IS NOT NULL AND "draftClaimKey" ~ '^[0-9a-f]{64}$'
            AND ("status" = 'FIXED') = ("settledAt" IS NOT NULL)
            AND "extractionId" IS NULL AND "checkRunId" IS NULL)
    )
    AND ("newerFactId" IS NULL OR "newerFactId" <> "factId")
    AND (("status" = 'PENDING') = ("decidedAt" IS NULL))
    AND ("basis" <> 'DEEP' OR "checkRunId" IS NOT NULL)
);

-- One OPEN draft mismatch a bible fact, scene and draft claim: a claim the author kept, updated the bible for or is
-- fixing is never raised again while it stands; a FIXED one (the draft stopped saying it) frees the claim.
CREATE UNIQUE INDEX "StoryFactProposal_one_open_draft" ON "StoryFactProposal"("workspaceId", "factId", "sceneId", "draftClaimKey")
    WHERE "basis" = 'DRAFT' AND "status" IN ('PENDING', 'FIX_PENDING', 'KEPT', 'BIBLE_UPDATED');

-- 4.1's "one proposal a pair, ever" (20261126110000) holds for the bible's own proposals only: a draft mismatch is held
-- by the index above instead. Kept ever for a draft pair, it silently refused the same pair raised again after a
-- settlement that left the draft fact live (FIXED when the scene's place in story time moved so the two facts no longer
-- overlapped): moved back, the clash stood again and was never raised.
DROP INDEX "StoryFactProposal_pair_key";
CREATE UNIQUE INDEX "StoryFactProposal_pair_key" ON "StoryFactProposal"("workspaceId", "factId", "newerFactId") NULLS NOT DISTINCT
    WHERE "basis" <> 'DRAFT';

-- 4.2's function, the draft columns added to what is fixed, and one more move: a FIX_PENDING proposal is SETTLED
-- (FIXED) once, by the re-read that no longer finds the claim, its decision (who, when) unchanged.
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
       OR (OLD."settledAt" IS NOT NULL AND NEW."settledAt" IS DISTINCT FROM OLD."settledAt") THEN
        RAISE EXCEPTION 'STORY_FACT_PROPOSAL_FIXED: only a pending proposal''s decision may be written, once' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."status" = 'FIX_PENDING' AND NEW."status" = 'FIXED' THEN
        IF NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt" OR NEW."decidedById" IS DISTINCT FROM OLD."decidedById" OR NEW."settledAt" IS NULL THEN
            RAISE EXCEPTION 'STORY_FACT_PROPOSAL_FIXED: settling a fix keeps its decision' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."status" <> 'PENDING' AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
           OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
           OR (NEW."decidedById" IS NOT NULL AND NEW."decidedById" IS DISTINCT FROM OLD."decidedById")) THEN
        RAISE EXCEPTION 'STORY_FACT_PROPOSAL_FIXED: only a pending proposal''s decision may be written, once' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;

-- ─── The nightly draft reading ─────────────────────────────────────────
ALTER TABLE "SceneDraftRead" ADD CONSTRAINT "SceneDraftRead_known" CHECK (
    "outcome" IN ('OK', 'EMPTY', 'CALL_OVER_BUDGET', 'GUARD_REFUSED', 'PASSED_OVER')
    AND "textKey" ~ '^[0-9a-f]{64}$'
    -- -1: never read at all (a first failure counted on a scene with no read yet keeps it due)
    AND "revision" >= -1 AND "failures" >= 0 AND "factsKept" >= 0 AND "costMicroUsd" >= 0
);
ALTER TABLE "DraftReadRun" ADD CONSTRAINT "DraftReadRun_status_known" CHECK ("status" IN ('QUEUED', 'RUNNING', 'DONE', 'STOPPED', 'SKIPPED', 'FAILED'));
ALTER TABLE "DraftReadRun" ADD CONSTRAINT "DraftReadRun_outcome_known" CHECK ("outcome" IS NULL OR "outcome" IN (
    'OK', 'PAGED', 'NOTHING_TO_READ', 'BOOK_DELETED', 'NO_ACTOR', 'CEILING', 'NIGHTLY_CAP', 'KILL_SWITCH', 'AI_UNAVAILABLE',
    'NOT_EVALUATED', 'MODEL_RATE_LIMITED', 'CALL_FAILED', 'ABORTED', 'CLAIM_EXPIRED', 'INTERNAL'));
ALTER TABLE "DraftReadRun" ADD CONSTRAINT "DraftReadRun_counts" CHECK (
    "scenesRead" >= 0 AND "scenesRemaining" >= 0 AND "factsKept" >= 0 AND "mismatchesRaised" >= 0 AND "mismatchesFixed" >= 0
    AND "linksProposed" >= 0 AND "callsMade" >= 0 AND "costMicroUsd" >= 0);

-- ─── Threads planted and paid off by scenes ────────────────────────────
ALTER TABLE "StoryThreadSceneLink" ADD CONSTRAINT "StoryThreadSceneLink_known" CHECK (
    "role" IN ('PLANTS', 'PAYS')
    AND "status" IN ('PENDING', 'CONFIRMED', 'REJECTED')
    AND (("status" = 'PENDING') = ("decidedAt" IS NULL))
    AND ("status" <> 'PENDING' OR "decidedById" IS NULL)
    AND "quoteStart" >= 0 AND "quoteEnd" > "quoteStart"
    AND "sceneTextKey" ~ '^[0-9a-f]{64}$'
    AND "flags" <@ ARRAY['POSSIBLE_INSTRUCTION']::text[]
);
-- A link is fixed but for its one decision, made once (who, when, what); its decider may be cleared only when that
-- person is deleted (their foreign key's SET NULL).
CREATE OR REPLACE FUNCTION story_thread_scene_link_fixed() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    decision_cols text[] := ARRAY['status', 'decidedById', 'decidedAt'];
BEGIN
    IF OLD."status" = 'PENDING' AND NEW."status" <> 'PENDING'
       AND (to_jsonb(NEW) - decision_cols) = (to_jsonb(OLD) - decision_cols) THEN
        RETURN NEW;
    END IF;
    IF OLD."decidedById" IS NOT NULL AND NEW."decidedById" IS NULL
       AND (to_jsonb(NEW) - 'decidedById') = (to_jsonb(OLD) - 'decidedById')
       AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."decidedById") THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'STORY_THREAD_SCENE_LINK_FIXED: a link changes only by its one decision' USING ERRCODE = 'P0001';
END;
$$;
DROP TRIGGER IF EXISTS story_thread_scene_link_fixed ON "StoryThreadSceneLink";
CREATE TRIGGER story_thread_scene_link_fixed BEFORE UPDATE ON "StoryThreadSceneLink" FOR EACH ROW EXECUTE FUNCTION story_thread_scene_link_fixed();

-- A link's thread is of the link's book (the composite foreign keys hold the workspace and the scene's book; the
-- thread's book is held here, AFTER, so row-level security refuses another workspace's row first).
CREATE OR REPLACE FUNCTION story_thread_scene_link_in_book() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "StoryThread" WHERE "id" = NEW."threadId" AND "bookId" = NEW."bookId") THEN
        RAISE EXCEPTION 'STORY_THREAD_SCENE_LINK_BOOK: a link''s thread is of its book' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS story_thread_scene_link_in_book ON "StoryThreadSceneLink";
CREATE TRIGGER story_thread_scene_link_in_book AFTER INSERT ON "StoryThreadSceneLink" FOR EACH ROW EXECUTE FUNCTION story_thread_scene_link_in_book();

-- ─── A scene's card ────────────────────────────────────────────────────
ALTER TABLE "SceneCard" ADD CONSTRAINT "SceneCard_version" CHECK ("version" >= 0);
-- An INTERVIEW card version names the answers it is drawn from (rule 1); a MANUAL one names none; nothing else writes one.
ALTER TABLE "SceneCardVersion" ADD CONSTRAINT "SceneCardVersion_shape"
    CHECK ("versionNumber" >= 1
       AND "source"::text IN ('MANUAL', 'INTERVIEW')
       AND ("source"::text = 'INTERVIEW') = (cardinality(coalesce("sourceAnswerIds", ARRAY[]::text[])) > 0));

-- A card's history is append-only, as a scene's text and note history are (the 5.1 function).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "SceneCardVersion" FROM app_user;
DROP TRIGGER IF EXISTS scene_card_version_no_update_delete ON "SceneCardVersion";
CREATE TRIGGER scene_card_version_no_update_delete
    BEFORE UPDATE OR DELETE ON "SceneCardVersion"
    FOR EACH ROW EXECUTE FUNCTION scene_version_append_only();
DROP TRIGGER IF EXISTS scene_card_version_no_truncate ON "SceneCardVersion";
CREATE TRIGGER scene_card_version_no_truncate
    BEFORE TRUNCATE ON "SceneCardVersion"
    FOR EACH STATEMENT EXECUTE FUNCTION scene_version_append_only();

-- ─── A MANUSCRIPT bible version names its scene ─────────────────────────
ALTER TABLE "BibleEntryVersion" ADD CONSTRAINT "BibleEntryVersion_manuscript_names_scene"
    CHECK (("source"::text = 'MANUSCRIPT') = ("sourceSceneId" IS NOT NULL));
-- ... and that scene is one of the version's own book, as it stands when the version is written. Held by a trigger,
-- not a foreign key: the version outlives its scene (an append-only history keeps the id it named), and AFTER, so
-- row-level security refuses another workspace's scene first (the 5.1 kind triggers' shape).
CREATE OR REPLACE FUNCTION bible_entry_version_manuscript_scene_in_book() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NEW."source"::text = 'MANUSCRIPT' AND NOT EXISTS (
        SELECT 1 FROM "ManuscriptScene" s WHERE s."id" = NEW."sourceSceneId" AND s."bookId" = NEW."bookId" AND s."workspaceId" = NEW."workspaceId") THEN
        RAISE EXCEPTION 'BIBLE_VERSION_MANUSCRIPT_SCENE: a MANUSCRIPT version names a scene of its own book' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bible_entry_version_manuscript_scene_in_book ON "BibleEntryVersion";
CREATE TRIGGER bible_entry_version_manuscript_scene_in_book AFTER INSERT ON "BibleEntryVersion"
    FOR EACH ROW WHEN (NEW."sourceSceneId" IS NOT NULL) EXECUTE FUNCTION bible_entry_version_manuscript_scene_in_book();
-- A relation's version is never MANUSCRIPT (5.3 updates an element's field only), nor RESEARCH (3.3).
ALTER TABLE "BibleRelationVersion" DROP CONSTRAINT "BibleRelationVersion_interview_names_answers";
ALTER TABLE "BibleRelationVersion" ADD CONSTRAINT "BibleRelationVersion_interview_names_answers"
    CHECK (("source" = 'INTERVIEW') = (cardinality(coalesce("sourceAnswerIds", ARRAY[]::text[])) > 0) AND "source"::text NOT IN ('RESEARCH', 'MANUSCRIPT'));
-- A scene's note version stays MANUAL or RESEARCH (its 5.1 CHECK already says so).

-- ─── A scene interview ─────────────────────────────────────────────────
ALTER TABLE "InterviewSession" DROP CONSTRAINT "InterviewSession_target_matches_scope";
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_target_matches_scope"
    CHECK (
        ("scope" = 'ELEMENT' AND "targetElementId" IS NOT NULL AND "targetKind" IS NULL)
        OR ("scope" = 'KIND' AND "targetElementId" IS NULL AND "targetKind" IS NOT NULL)
        OR ("scope" = 'BOOK' AND "targetElementId" IS NULL AND "targetKind" IS NULL)
        OR ("scope" IN ('SELECTION', 'BETWEEN', 'SCENE') AND "targetElementId" IS NULL AND "targetKind" IS NULL)
    );
-- A SCENE session names its scene; no other scope names one.
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_scene_shape"
    CHECK (("scope"::text = 'SCENE') = ("sceneId" IS NOT NULL));
-- A question is about one subject: an element, a relation, the slot's element not yet created, a pair, or a scene's card.
ALTER TABLE "Question" DROP CONSTRAINT "Question_one_subject";
ALTER TABLE "Question" ADD CONSTRAINT "Question_one_subject"
    CHECK (NOT ("relationId" IS NOT NULL AND "aboutPending")
       AND ("sceneId" IS NULL OR ("relationId" IS NULL AND NOT "aboutPending" AND "pairElementId" IS NULL AND "storyFactId" IS NULL)));

-- One shape per proposal kind (the 3.H CHECK, a SCENE_CARD_FIELD added): a scene card's field, an operation, the
-- card's version (0: no card yet); no element, relation or new element. Only that kind names a scene.
ALTER TABLE "EnrichmentProposal" DROP CONSTRAINT "EnrichmentProposal_kind_shape";
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_kind_shape"
    CHECK (
        ("kind" = 'FIELD'
            AND "fieldKey" IS NOT NULL AND "operation" IS NOT NULL
            AND (("elementId" IS NOT NULL AND "targetProposalId" IS NULL AND "baseVersion" IS NOT NULL)
                 OR ("elementId" IS NULL AND "targetProposalId" IS NOT NULL AND "baseVersion" IS NULL AND "operation" = 'ADD'))
            AND "relationId" IS NULL AND "sceneId" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND (("operation" = 'REMOVE') = ("proposedValue" IS NULL)))
        OR
        ("kind" = 'RELATION_FIELD'
            AND "relationId" IS NOT NULL AND "fieldKey" IS NOT NULL AND "operation" IS NOT NULL AND "baseVersion" IS NOT NULL
            AND "elementId" IS NULL AND "targetProposalId" IS NULL AND "sceneId" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND (("operation" = 'REMOVE') = ("proposedValue" IS NULL)))
        OR
        ("kind" = 'NEW_ELEMENT'
            AND "elementId" IS NULL AND "relationId" IS NULL AND "fieldKey" IS NULL AND "operation" IS NULL AND "baseVersion" IS NULL
            AND "targetProposalId" IS NULL AND "sceneId" IS NULL
            AND "newKind" IS NOT NULL AND "newName" IS NOT NULL AND "versionId" IS NULL)
        OR
        ("kind" = 'NEW_RELATION'
            AND "elementId" IS NULL AND "relationId" IS NULL AND "fieldKey" IS NULL AND "operation" IS NULL AND "baseVersion" IS NULL
            AND "targetProposalId" IS NULL AND "sceneId" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND "proposedValue" IS NOT NULL AND "newRelationType" IS NOT NULL
            AND (("newFromElementId" IS NULL) <> ("newFromProposalId" IS NULL))
            AND (("newToElementId" IS NULL) <> ("newToProposalId" IS NULL)))
        OR
        ("kind" = 'SCENE_CARD_FIELD'
            AND "sceneId" IS NOT NULL AND "fieldKey" IS NOT NULL AND "operation" IS NOT NULL AND "baseVersion" IS NOT NULL
            AND "elementId" IS NULL AND "relationId" IS NULL AND "targetProposalId" IS NULL
            AND "newKind" IS NULL AND "newName" IS NULL AND "newSummary" IS NULL AND "createdElementId" IS NULL
            AND (("operation" = 'REMOVE') = ("proposedValue" IS NULL)))
    );
ALTER TABLE "EnrichmentProposal" DROP CONSTRAINT "EnrichmentProposal_baseVersion_positive";
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_baseVersion_positive"
    CHECK ("baseVersion" IS NULL OR "baseVersion" >= 1 OR ("kind" IN ('RELATION_FIELD', 'SCENE_CARD_FIELD') AND "baseVersion" = 0));
ALTER TABLE "EnrichmentProposal" DROP CONSTRAINT "EnrichmentProposal_decision_shape";
ALTER TABLE "EnrichmentProposal" ADD CONSTRAINT "EnrichmentProposal_decision_shape"
    CHECK (
        ("status" = 'PENDING') = ("decidedAt" IS NULL)
        AND ("status" <> 'PENDING' OR ("decidedById" IS NULL AND "versionId" IS NULL AND "createdElementId" IS NULL AND "createdRelationId" IS NULL))
        AND ("status" NOT IN ('ACCEPTED', 'EDITED_ACCEPTED')
             OR ("kind" IN ('FIELD', 'RELATION_FIELD', 'SCENE_CARD_FIELD') AND "versionId" IS NOT NULL)
             OR ("kind" = 'NEW_ELEMENT' AND "createdElementId" IS NOT NULL)
             OR ("kind" = 'NEW_RELATION' AND "createdRelationId" IS NOT NULL AND "versionId" IS NOT NULL))
        AND ("status" IN ('ACCEPTED', 'EDITED_ACCEPTED') OR ("versionId" IS NULL AND "createdElementId" IS NULL AND "createdRelationId" IS NULL))
    );

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "SceneDraftRead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SceneDraftRead" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SceneDraftRead";
CREATE POLICY workspace_isolation ON "SceneDraftRead"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SceneDraftRead";
CREATE POLICY superuser_bypass ON "SceneDraftRead"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "DraftReadRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DraftReadRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "DraftReadRun";
CREATE POLICY workspace_isolation ON "DraftReadRun"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "DraftReadRun";
CREATE POLICY superuser_bypass ON "DraftReadRun"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "StoryThreadSceneLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoryThreadSceneLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StoryThreadSceneLink";
CREATE POLICY workspace_isolation ON "StoryThreadSceneLink"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StoryThreadSceneLink";
CREATE POLICY superuser_bypass ON "StoryThreadSceneLink"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "SceneCard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SceneCard" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SceneCard";
CREATE POLICY workspace_isolation ON "SceneCard"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SceneCard";
CREATE POLICY superuser_bypass ON "SceneCard"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "SceneCardVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SceneCardVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SceneCardVersion";
CREATE POLICY workspace_isolation ON "SceneCardVersion"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SceneCardVersion";
CREATE POLICY superuser_bypass ON "SceneCardVersion"
    USING (current_setting('role') != 'app_user');
