-- Phase 4.1 — the fact layer and retrieval (decision D27).
--
-- StoryFact, 4.0's fact model, is extended to the bible itself: a fact may now
-- be drawn from an accepted element version or relation version, where it
-- counts at once (automatic, CONFIRMED), beside the source facts the author
-- confirms. No second fact table: a kind and its columns, paired by CHECK.
--
--   StoryFactProvenance   a later version restating a live bible fact (one live fact per claim)
--   StoryFactProposal     a live fact proposed for invalidation; never resolved silently
--   BibleFactExtraction   the extraction OUTBOX: one row per accepted version, written by
--                         trigger IN THE VERSION'S TRANSACTION (a rolled-back save writes none)
--   EmbeddingTask         a source row whose vector is due (element, fact, answer), by trigger
--
-- Elements, facts and answers become vector source models (the 2.0 delete
-- and require-source triggers). A chunk may be marked unreadable (#57 item 2).
-- Every new table is workspace-scoped: FORCE RLS, `workspace_isolation`,
-- `superuser_bypass`.

-- AlterTable
ALTER TABLE "SourceChunk" ADD COLUMN     "unreadableReason" TEXT;

-- AlterTable
ALTER TABLE "StoryFact" ADD COLUMN     "automatic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bibleVersionId" TEXT,
ADD COLUMN     "bookId" TEXT,
ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "elementId" TEXT,
ADD COLUMN     "invalidatedByFactId" TEXT,
ADD COLUMN     "relationId" TEXT,
ADD COLUMN     "relationVersionId" TEXT,
ALTER COLUMN "sourceId" DROP NOT NULL,
ALTER COLUMN "chunkId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "StoryFactProvenance" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "sourceKind" "StoryFactSourceKind" NOT NULL,
    "bibleVersionId" TEXT,
    "relationVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryFactProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryFactProposal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "newerFactId" TEXT,
    "reason" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "extractionId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryFactProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BibleFactExtraction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "elementId" TEXT,
    "relationId" TEXT,
    "bibleVersionId" TEXT,
    "relationVersionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "factsAdded" INTEGER NOT NULL DEFAULT 0,
    "provenanceAdded" INTEGER NOT NULL DEFAULT 0,
    "proposalsRaised" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "promptVersion" TEXT,
    "metrics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BibleFactExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmbeddingTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceModel" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmbeddingTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoryFactProvenance_workspaceId_factId_idx" ON "StoryFactProvenance"("workspaceId", "factId");

-- CreateIndex
CREATE INDEX "StoryFactProvenance_bibleVersionId_idx" ON "StoryFactProvenance"("bibleVersionId");

-- CreateIndex
CREATE INDEX "StoryFactProvenance_relationVersionId_idx" ON "StoryFactProvenance"("relationVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "StoryFactProvenance_factId_bibleVersionId_key" ON "StoryFactProvenance"("factId", "bibleVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "StoryFactProvenance_factId_relationVersionId_key" ON "StoryFactProvenance"("factId", "relationVersionId");

-- CreateIndex
CREATE INDEX "StoryFactProposal_workspaceId_bookId_status_createdAt_idx" ON "StoryFactProposal"("workspaceId", "bookId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "StoryFactProposal_workspaceId_factId_idx" ON "StoryFactProposal"("workspaceId", "factId");

-- CreateIndex
CREATE INDEX "StoryFactProposal_workspaceId_newerFactId_idx" ON "StoryFactProposal"("workspaceId", "newerFactId");

-- CreateIndex
CREATE INDEX "StoryFactProposal_decidedById_idx" ON "StoryFactProposal"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "StoryFactProposal_workspaceId_id_key" ON "StoryFactProposal"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BibleFactExtraction_bibleVersionId_key" ON "BibleFactExtraction"("bibleVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "BibleFactExtraction_relationVersionId_key" ON "BibleFactExtraction"("relationVersionId");

-- CreateIndex
CREATE INDEX "BibleFactExtraction_status_createdAt_idx" ON "BibleFactExtraction"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BibleFactExtraction_workspaceId_elementId_status_createdAt_idx" ON "BibleFactExtraction"("workspaceId", "elementId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BibleFactExtraction_workspaceId_relationId_status_createdAt_idx" ON "BibleFactExtraction"("workspaceId", "relationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BibleFactExtraction_workspaceId_bookId_createdAt_idx" ON "BibleFactExtraction"("workspaceId", "bookId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BibleFactExtraction_workspaceId_id_key" ON "BibleFactExtraction"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "EmbeddingTask_createdAt_idx" ON "EmbeddingTask"("createdAt");

-- CreateIndex
CREATE INDEX "EmbeddingTask_workspaceId_createdAt_idx" ON "EmbeddingTask"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingTask_workspaceId_sourceModel_sourceId_key" ON "EmbeddingTask"("workspaceId", "sourceModel", "sourceId");

-- CreateIndex
CREATE INDEX "StoryFact_workspaceId_bookId_elementId_supersededAt_idx" ON "StoryFact"("workspaceId", "bookId", "elementId", "supersededAt");

-- CreateIndex
CREATE INDEX "StoryFact_workspaceId_relationId_idx" ON "StoryFact"("workspaceId", "relationId");

-- CreateIndex
CREATE INDEX "StoryFact_workspaceId_elementId_idx" ON "StoryFact"("workspaceId", "elementId");

-- CreateIndex
CREATE INDEX "StoryFact_workspaceId_bookId_subjectElementId_idx" ON "StoryFact"("workspaceId", "bookId", "subjectElementId");

-- CreateIndex
CREATE INDEX "StoryFact_bibleVersionId_idx" ON "StoryFact"("bibleVersionId");

-- CreateIndex
CREATE INDEX "StoryFact_relationVersionId_idx" ON "StoryFact"("relationVersionId");

-- CreateIndex
CREATE INDEX "StoryFact_invalidatedByFactId_idx" ON "StoryFact"("invalidatedByFactId");

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_workspaceId_elementId_fkey" FOREIGN KEY ("workspaceId", "elementId") REFERENCES "BibleElement"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_workspaceId_relationId_fkey" FOREIGN KEY ("workspaceId", "relationId") REFERENCES "BibleRelation"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_bibleVersionId_fkey" FOREIGN KEY ("bibleVersionId") REFERENCES "BibleEntryVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_relationVersionId_fkey" FOREIGN KEY ("relationVersionId") REFERENCES "BibleRelationVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_invalidatedByFactId_fkey" FOREIGN KEY ("invalidatedByFactId") REFERENCES "StoryFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactProvenance" ADD CONSTRAINT "StoryFactProvenance_workspaceId_factId_fkey" FOREIGN KEY ("workspaceId", "factId") REFERENCES "StoryFact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactProvenance" ADD CONSTRAINT "StoryFactProvenance_bibleVersionId_fkey" FOREIGN KEY ("bibleVersionId") REFERENCES "BibleEntryVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactProvenance" ADD CONSTRAINT "StoryFactProvenance_relationVersionId_fkey" FOREIGN KEY ("relationVersionId") REFERENCES "BibleRelationVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactProposal" ADD CONSTRAINT "StoryFactProposal_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactProposal" ADD CONSTRAINT "StoryFactProposal_workspaceId_factId_fkey" FOREIGN KEY ("workspaceId", "factId") REFERENCES "StoryFact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactProposal" ADD CONSTRAINT "StoryFactProposal_workspaceId_newerFactId_fkey" FOREIGN KEY ("workspaceId", "newerFactId") REFERENCES "StoryFact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactProposal" ADD CONSTRAINT "StoryFactProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_bibleVersionId_fkey" FOREIGN KEY ("bibleVersionId") REFERENCES "BibleEntryVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_relationVersionId_fkey" FOREIGN KEY ("relationVersionId") REFERENCES "BibleRelationVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbeddingTask" ADD CONSTRAINT "EmbeddingTask_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── StoryFact: a kind and its columns ──────────────────────────────────
-- SOURCE_CHUNK names its source and passage and nothing of the bible; a bible
-- fact names its book, its subject (the element, or the relation), its version
-- and its claim key, is automatic and CONFIRMED, and names no source.
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_kind_columns" CHECK (
    CASE "sourceKind"::text
        WHEN 'SOURCE_CHUNK' THEN "sourceId" IS NOT NULL AND "chunkId" IS NOT NULL AND "bookId" IS NULL AND "elementId" IS NULL
            AND "relationId" IS NULL AND "bibleVersionId" IS NULL AND "relationVersionId" IS NULL AND NOT "automatic" AND "dedupeKey" IS NULL
        WHEN 'BIBLE_VERSION' THEN "sourceId" IS NULL AND "chunkId" IS NULL AND "bookId" IS NOT NULL AND "elementId" IS NOT NULL
            AND "relationId" IS NULL AND "bibleVersionId" IS NOT NULL AND "relationVersionId" IS NULL AND "automatic"
            AND "dedupeKey" IS NOT NULL AND "status" = 'CONFIRMED' AND "carriedFromFactId" IS NULL
        WHEN 'RELATION_VERSION' THEN "sourceId" IS NULL AND "chunkId" IS NULL AND "bookId" IS NOT NULL AND "elementId" IS NULL
            AND "relationId" IS NOT NULL AND "bibleVersionId" IS NULL AND "relationVersionId" IS NOT NULL AND "automatic"
            AND "dedupeKey" IS NOT NULL AND "status" = 'CONFIRMED' AND "carriedFromFactId" IS NULL
        ELSE false
    END
);
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_dedupe_key_shape" CHECK ("dedupeKey" IS NULL OR "dedupeKey" ~ '^[0-9a-f]{64}$');
-- Invalidation is a decision: it names the newer fact only with the time it was made (the pointer may go NULL with that fact).
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_invalidation" CHECK ("invalidatedByFactId" IS NULL OR "supersededAt" IS NOT NULL);
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_not_self_invalidated" CHECK ("invalidatedByFactId" IS NULL OR "invalidatedByFactId" <> "id");
-- ONE LIVE FACT PER CLAIM in a book (D27; Prisma cannot spell a partial unique index).
CREATE UNIQUE INDEX "StoryFact_one_live_claim" ON "StoryFact"("workspaceId", "bookId", "dedupeKey") WHERE "supersededAt" IS NULL AND "dedupeKey" IS NOT NULL;

ALTER TABLE "SourceChunk" ADD CONSTRAINT "SourceChunk_unreadable_known" CHECK ("unreadableReason" IS NULL OR ("unreadableReason" IN ('REPEATS_PROMPT') AND "extractedAt" IS NOT NULL));

-- A fact is fixed once written: only its decision (status, who, when), its
-- invalidation (once: `supersededAt` and `invalidatedByFactId` from NULL, the
-- pointer back to NULL only when that fact is deleted), and the element links
-- an element's deletion clears may change. What it says, what it quotes and
-- where it comes from never do (rule 1: the author decided about exactly
-- these words; an accepted version stated exactly these).
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
       OR NEW."dedupeKey" IS DISTINCT FROM OLD."dedupeKey"
       OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt")
       OR (NEW."invalidatedByFactId" IS NOT NULL AND NEW."invalidatedByFactId" IS DISTINCT FROM OLD."invalidatedByFactId" AND OLD."supersededAt" IS NOT NULL)
       OR (NEW."subjectElementId" IS NOT NULL AND NEW."subjectElementId" IS DISTINCT FROM OLD."subjectElementId")
       OR (NEW."objectElementId" IS NOT NULL AND NEW."objectElementId" IS DISTINCT FROM OLD."objectElementId") THEN
        RAISE EXCEPTION 'STORY_FACT_FIXED: only a fact''s decision may change' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;

-- ─── Provenance ────────────────────────────────────────────────────────
ALTER TABLE "StoryFactProvenance" ADD CONSTRAINT "StoryFactProvenance_kind_columns" CHECK (
    CASE "sourceKind"::text
        WHEN 'BIBLE_VERSION' THEN "bibleVersionId" IS NOT NULL AND "relationVersionId" IS NULL
        WHEN 'RELATION_VERSION' THEN "relationVersionId" IS NOT NULL AND "bibleVersionId" IS NULL
        ELSE false
    END
);
CREATE OR REPLACE FUNCTION story_fact_provenance_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'STORY_FACT_PROVENANCE_APPEND_ONLY: a provenance row is never changed' USING ERRCODE = 'P0001';
END
$$;
DROP TRIGGER IF EXISTS story_fact_provenance_append_only ON "StoryFactProvenance";
CREATE TRIGGER story_fact_provenance_append_only BEFORE UPDATE ON "StoryFactProvenance" FOR EACH ROW EXECUTE FUNCTION story_fact_provenance_append_only();

-- ─── Proposals ─────────────────────────────────────────────────────────
ALTER TABLE "StoryFactProposal" ADD CONSTRAINT "StoryFactProposal_known" CHECK (
    "status" IN ('PENDING', 'INVALIDATED', 'KEPT', 'REJECTED')
    AND (("reason" = 'CONTRADICTED' AND "basis" IN ('RULE', 'MODEL') AND "newerFactId" IS NOT NULL)
      OR ("reason" = 'NO_LONGER_STATED' AND "basis" = 'TEXT' AND "newerFactId" IS NULL))
    AND ("newerFactId" IS NULL OR "newerFactId" <> "factId")
    AND (("status" = 'PENDING') = ("decidedAt" IS NULL))
);
-- One proposal per pair, ever: a pair the author decided is never asked again.
CREATE UNIQUE INDEX "StoryFactProposal_pair_key" ON "StoryFactProposal"("workspaceId", "factId", "newerFactId") NULLS NOT DISTINCT;
-- A proposal is fixed but for its one decision, made once.
CREATE OR REPLACE FUNCTION story_fact_proposal_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."bookId" IS DISTINCT FROM OLD."bookId"
       OR NEW."factId" IS DISTINCT FROM OLD."factId" OR NEW."newerFactId" IS DISTINCT FROM OLD."newerFactId"
       OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."basis" IS DISTINCT FROM OLD."basis"
       OR NEW."extractionId" IS DISTINCT FROM OLD."extractionId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR (OLD."status" <> 'PENDING' AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
           OR (NEW."decidedById" IS NOT NULL AND NEW."decidedById" IS DISTINCT FROM OLD."decidedById"))) THEN
        RAISE EXCEPTION 'STORY_FACT_PROPOSAL_FIXED: only a pending proposal''s decision may be written, once' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS story_fact_proposal_fixed ON "StoryFactProposal";
CREATE TRIGGER story_fact_proposal_fixed BEFORE UPDATE ON "StoryFactProposal" FOR EACH ROW EXECUTE FUNCTION story_fact_proposal_fixed();

-- ─── The extraction outbox ─────────────────────────────────────────────
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_kind_columns" CHECK (
    ("kind" = 'BIBLE_VERSION' AND "bibleVersionId" IS NOT NULL AND "elementId" IS NOT NULL AND "relationVersionId" IS NULL AND "relationId" IS NULL)
    OR ("kind" = 'RELATION_VERSION' AND "relationVersionId" IS NOT NULL AND "relationId" IS NOT NULL AND "bibleVersionId" IS NULL AND "elementId" IS NULL)
);
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_status_known" CHECK ("status" IN ('PENDING', 'QUEUED', 'RUNNING', 'DONE', 'SKIPPED', 'STOPPED', 'FAILED'));
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_outcome_known" CHECK ("outcome" IS NULL OR "outcome" IN (
    'OK', 'NO_CHANGE', 'SUPERSEDED', 'SUBJECT_GONE', 'BOOK_DELETED', 'AUTHOR_NOT_PERMITTED', 'CEILING', 'KILL_SWITCH', 'AI_UNAVAILABLE',
    'NOT_EVALUATED', 'MODEL_RATE_LIMITED', 'GUARD_REFUSED', 'REPEATS_PROMPT', 'CALL_FAILED', 'ABORTED', 'CLAIM_EXPIRED', 'ATTEMPTS_SPENT', 'INTERNAL'));
ALTER TABLE "BibleFactExtraction" ADD CONSTRAINT "BibleFactExtraction_counts" CHECK ("attempts" >= 0 AND "factsAdded" >= 0 AND "provenanceAdded" >= 0 AND "proposalsRaised" >= 0 AND "costMicroUsd" >= 0);

-- An accepted version writes its extraction row, and marks its element for
-- embedding, in its own transaction: a version rolled back leaves neither, so
-- nothing is ever extracted for a save that did not happen (D27).
CREATE OR REPLACE FUNCTION bible_entry_version_fact_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "BibleFactExtraction" ("id", "workspaceId", "bookId", "kind", "elementId", "bibleVersionId")
        VALUES (gen_random_uuid()::text, NEW."workspaceId", NEW."bookId", 'BIBLE_VERSION', NEW."elementId", NEW."id");
    INSERT INTO "EmbeddingTask" ("id", "workspaceId", "sourceModel", "sourceId")
        VALUES (gen_random_uuid()::text, NEW."workspaceId", 'BibleElement', NEW."elementId")
        ON CONFLICT ("workspaceId", "sourceModel", "sourceId") DO NOTHING;
    RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS bible_entry_version_fact_outbox ON "BibleEntryVersion";
CREATE TRIGGER bible_entry_version_fact_outbox AFTER INSERT ON "BibleEntryVersion" FOR EACH ROW EXECUTE FUNCTION bible_entry_version_fact_outbox();

CREATE OR REPLACE FUNCTION bible_relation_version_fact_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "BibleFactExtraction" ("id", "workspaceId", "bookId", "kind", "relationId", "relationVersionId")
        VALUES (gen_random_uuid()::text, NEW."workspaceId", NEW."bookId", 'RELATION_VERSION', NEW."relationId", NEW."id");
    RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS bible_relation_version_fact_outbox ON "BibleRelationVersion";
CREATE TRIGGER bible_relation_version_fact_outbox AFTER INSERT ON "BibleRelationVersion" FOR EACH ROW EXECUTE FUNCTION bible_relation_version_fact_outbox();

-- ─── Embedding tasks ───────────────────────────────────────────────────
ALTER TABLE "EmbeddingTask" ADD CONSTRAINT "EmbeddingTask_model_known" CHECK ("sourceModel" IN ('BibleElement', 'StoryFact', 'Answer') AND "attempts" >= 0);

CREATE OR REPLACE FUNCTION story_embedding_task() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_NARGS <> 1 OR TG_ARGV[0] NOT IN ('StoryFact', 'Answer') THEN
        RAISE EXCEPTION 'EMBEDDING_TASK_TRIGGER_MISCONFIGURED: % must name its source model', TG_TABLE_NAME USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO "EmbeddingTask" ("id", "workspaceId", "sourceModel", "sourceId")
        VALUES (gen_random_uuid()::text, NEW."workspaceId", TG_ARGV[0], NEW."id")
        ON CONFLICT ("workspaceId", "sourceModel", "sourceId") DO NOTHING;
    RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS story_fact_embedding_task ON "StoryFact";
CREATE TRIGGER story_fact_embedding_task AFTER INSERT ON "StoryFact" FOR EACH ROW EXECUTE FUNCTION story_embedding_task('StoryFact');
DROP TRIGGER IF EXISTS answer_embedding_task ON "Answer";
CREATE TRIGGER answer_embedding_task AFTER INSERT ON "Answer" FOR EACH ROW WHEN (NEW."status" = 'ANSWERED') EXECUTE FUNCTION story_embedding_task('Answer');

-- ─── Three more vector source models (subphase 2.0, D8) ────────────────
-- An element's, a fact's and an answer's vectors go with the row, and none is
-- written for a row that is gone.
DROP TRIGGER IF EXISTS "BibleElement_vector_embedding_delete" ON "BibleElement";
CREATE TRIGGER "BibleElement_vector_embedding_delete" AFTER DELETE ON "BibleElement" FOR EACH ROW EXECUTE FUNCTION vector_embedding_delete_with_source('BibleElement');
DROP TRIGGER IF EXISTS "VectorEmbedding_bible_element_guard" ON "VectorEmbedding";
CREATE TRIGGER "VectorEmbedding_bible_element_guard" BEFORE INSERT ON "VectorEmbedding" FOR EACH ROW
    WHEN (NEW."sourceModel" = 'BibleElement') EXECUTE FUNCTION vector_embedding_require_source('BibleElement', 'BibleElement');

DROP TRIGGER IF EXISTS "StoryFact_vector_embedding_delete" ON "StoryFact";
CREATE TRIGGER "StoryFact_vector_embedding_delete" AFTER DELETE ON "StoryFact" FOR EACH ROW EXECUTE FUNCTION vector_embedding_delete_with_source('StoryFact');
DROP TRIGGER IF EXISTS "VectorEmbedding_story_fact_guard" ON "VectorEmbedding";
CREATE TRIGGER "VectorEmbedding_story_fact_guard" BEFORE INSERT ON "VectorEmbedding" FOR EACH ROW
    WHEN (NEW."sourceModel" = 'StoryFact') EXECUTE FUNCTION vector_embedding_require_source('StoryFact', 'StoryFact');

DROP TRIGGER IF EXISTS "Answer_vector_embedding_delete" ON "Answer";
CREATE TRIGGER "Answer_vector_embedding_delete" AFTER DELETE ON "Answer" FOR EACH ROW EXECUTE FUNCTION vector_embedding_delete_with_source('Answer');
-- An answer is append-only: app_user holds no UPDATE on it, so the guard cannot
-- take the KEY SHARE lock the other sources' guard takes. It checks the answer
-- is there (under the writer's RLS); an answer is deleted only with its session's
-- cascade, which takes its vectors by the delete trigger above.
CREATE OR REPLACE FUNCTION vector_embedding_require_append_only_source() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    found_rows integer;
BEGIN
    IF TG_NARGS <> 2 OR TG_ARGV[0] !~ '^[A-Z][A-Za-z0-9]{0,63}$' OR TG_ARGV[1] !~ '^[A-Za-z][A-Za-z0-9_]{0,62}$' THEN
        RAISE EXCEPTION 'VECTOR_SOURCE_TRIGGER_MISCONFIGURED: the guard on % must name its source model and table', TG_TABLE_NAME
            USING ERRCODE = 'P0001';
    END IF;
    IF NEW."sourceModel" <> TG_ARGV[0] THEN
        RETURN NEW;
    END IF;
    EXECUTE format('SELECT 1 FROM %I.%I WHERE "id" = $1 AND "workspaceId" = $2', TG_TABLE_SCHEMA, TG_ARGV[1])
        USING NEW."sourceId", NEW."workspaceId";
    GET DIAGNOSTICS found_rows = ROW_COUNT;
    IF found_rows > 0 THEN
        RETURN NEW;
    END IF;
    IF NEW."rebuildGeneration" IS NOT NULL THEN
        RETURN NULL;
    END IF;
    RAISE EXCEPTION 'VECTOR_SOURCE_MISSING: no % row % for this vector', TG_ARGV[0], NEW."sourceId"
        USING ERRCODE = 'P0001';
END
$$;
DROP TRIGGER IF EXISTS "VectorEmbedding_answer_guard" ON "VectorEmbedding";
CREATE TRIGGER "VectorEmbedding_answer_guard" BEFORE INSERT ON "VectorEmbedding" FOR EACH ROW
    WHEN (NEW."sourceModel" = 'Answer') EXECUTE FUNCTION vector_embedding_require_append_only_source('Answer', 'Answer');

-- ─── Row-level security ────────────────────────────────────────────────

ALTER TABLE "StoryFactProvenance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoryFactProvenance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StoryFactProvenance";
CREATE POLICY workspace_isolation ON "StoryFactProvenance"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StoryFactProvenance";
CREATE POLICY superuser_bypass ON "StoryFactProvenance"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "StoryFactProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoryFactProposal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StoryFactProposal";
CREATE POLICY workspace_isolation ON "StoryFactProposal"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StoryFactProposal";
CREATE POLICY superuser_bypass ON "StoryFactProposal"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "BibleFactExtraction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BibleFactExtraction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "BibleFactExtraction";
CREATE POLICY workspace_isolation ON "BibleFactExtraction"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "BibleFactExtraction";
CREATE POLICY superuser_bypass ON "BibleFactExtraction"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "EmbeddingTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmbeddingTask" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "EmbeddingTask";
CREATE POLICY workspace_isolation ON "EmbeddingTask"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "EmbeddingTask";
CREATE POLICY superuser_bypass ON "EmbeddingTask"
    USING (current_setting('role') != 'app_user');
