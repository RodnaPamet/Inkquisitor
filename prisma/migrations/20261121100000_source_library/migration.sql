-- Phase 4.0 — the source library and ingestion (decisions D23, D26).
--
-- A book's library and the workspace's series library; uploaded sources kept
-- as encrypted chunks only (no file is stored); StoryFacts drawn from the
-- chunks, each citing its exact span and PENDING until the author decides;
-- a book's opt-in to series sources and its overrides of inherited facts.
--
-- Every table is workspace-scoped: FORCE RLS with `workspace_isolation` and
-- `superuser_bypass`, as every workspace table has. A chunk is the vector
-- store's second source model: its vectors go with it, and none is written
-- for a chunk that is gone (the 2.0 / 2.2 trigger functions, attached below).

CREATE TYPE "SourceLibraryScope" AS ENUM ('BOOK', 'SERIES');

CREATE TYPE "SourceFormat" AS ENUM ('DOCX', 'MARKDOWN', 'TXT', 'EPUB', 'PDF');

CREATE TYPE "SourceStatus" AS ENUM ('ESTIMATED', 'QUEUED', 'RUNNING', 'STOPPED', 'DONE', 'FAILED');

CREATE TYPE "StoryFactStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

CREATE TYPE "StoryFactSourceKind" AS ENUM ('SOURCE_CHUNK');

-- CreateTable
CREATE TABLE "SourceLibrary" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scope" "SourceLibraryScope" NOT NULL,
    "bookId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceLibrary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "format" "SourceFormat" NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "status" "SourceStatus" NOT NULL DEFAULT 'ESTIMATED',
    "outcome" TEXT,
    "chunkCount" INTEGER NOT NULL,
    "chunksDone" INTEGER NOT NULL DEFAULT 0,
    "factCount" INTEGER NOT NULL DEFAULT 0,
    "estimateMicroUsd" BIGINT NOT NULL,
    "worstCaseMicroUsd" BIGINT NOT NULL,
    "budgetMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "spentMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "metrics" JSONB,
    "promptVersion" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceChunk" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "headingPath" TEXT,
    "text" TEXT NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "tokenEstimate" INTEGER NOT NULL,
    "extractedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryFact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceKind" "StoryFactSourceKind" NOT NULL DEFAULT 'SOURCE_CHUNK',
    "sourceId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "subjectName" TEXT NOT NULL,
    "subjectElementId" TEXT,
    "predicate" TEXT NOT NULL,
    "objectElementId" TEXT,
    "objectLiteral" TEXT,
    "statement" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "quoteStart" INTEGER NOT NULL,
    "quoteEnd" INTEGER NOT NULL,
    "storyTimeFrom" TEXT,
    "storyTimeTo" TEXT,
    "statedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "status" "StoryFactStatus" NOT NULL DEFAULT 'PENDING',
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "carriedFromFactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookSeriesSource" (
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookSeriesSource_pkey" PRIMARY KEY ("bookId","sourceId")
);

-- CreateTable
CREATE TABLE "StoryFactOverride" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryFactOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceLibrary_bookId_idx" ON "SourceLibrary"("bookId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceLibrary_workspaceId_id_key" ON "SourceLibrary"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SourceLibrary_workspaceId_bookId_key" ON "SourceLibrary"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "Source_workspaceId_libraryId_createdAt_idx" ON "Source"("workspaceId", "libraryId", "createdAt");

-- CreateIndex
CREATE INDEX "Source_requestedById_idx" ON "Source"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "Source_workspaceId_id_key" ON "Source"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SourceChunk_workspaceId_id_key" ON "SourceChunk"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SourceChunk_workspaceId_sourceId_position_key" ON "SourceChunk"("workspaceId", "sourceId", "position");

-- CreateIndex
CREATE INDEX "StoryFact_workspaceId_sourceId_status_chunkId_position_idx" ON "StoryFact"("workspaceId", "sourceId", "status", "chunkId", "position");

-- CreateIndex
CREATE INDEX "StoryFact_workspaceId_chunkId_idx" ON "StoryFact"("workspaceId", "chunkId");

-- CreateIndex
CREATE INDEX "StoryFact_subjectElementId_idx" ON "StoryFact"("subjectElementId");

-- CreateIndex
CREATE INDEX "StoryFact_objectElementId_idx" ON "StoryFact"("objectElementId");

-- CreateIndex
CREATE INDEX "StoryFact_decidedById_idx" ON "StoryFact"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "StoryFact_workspaceId_id_key" ON "StoryFact"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "BookSeriesSource_workspaceId_bookId_idx" ON "BookSeriesSource"("workspaceId", "bookId");

-- CreateIndex
CREATE INDEX "BookSeriesSource_workspaceId_sourceId_idx" ON "BookSeriesSource"("workspaceId", "sourceId");

-- CreateIndex
CREATE INDEX "StoryFactOverride_workspaceId_factId_idx" ON "StoryFactOverride"("workspaceId", "factId");

-- CreateIndex
CREATE INDEX "StoryFactOverride_createdById_idx" ON "StoryFactOverride"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "StoryFactOverride_workspaceId_id_key" ON "StoryFactOverride"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StoryFactOverride_workspaceId_bookId_factId_key" ON "StoryFactOverride"("workspaceId", "bookId", "factId");

-- AddForeignKey
ALTER TABLE "SourceLibrary" ADD CONSTRAINT "SourceLibrary_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceLibrary" ADD CONSTRAINT "SourceLibrary_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_workspaceId_libraryId_fkey" FOREIGN KEY ("workspaceId", "libraryId") REFERENCES "SourceLibrary"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceChunk" ADD CONSTRAINT "SourceChunk_workspaceId_sourceId_fkey" FOREIGN KEY ("workspaceId", "sourceId") REFERENCES "Source"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_workspaceId_sourceId_fkey" FOREIGN KEY ("workspaceId", "sourceId") REFERENCES "Source"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_workspaceId_chunkId_fkey" FOREIGN KEY ("workspaceId", "chunkId") REFERENCES "SourceChunk"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_subjectElementId_fkey" FOREIGN KEY ("subjectElementId") REFERENCES "BibleElement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_objectElementId_fkey" FOREIGN KEY ("objectElementId") REFERENCES "BibleElement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSeriesSource" ADD CONSTRAINT "BookSeriesSource_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSeriesSource" ADD CONSTRAINT "BookSeriesSource_workspaceId_sourceId_fkey" FOREIGN KEY ("workspaceId", "sourceId") REFERENCES "Source"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactOverride" ADD CONSTRAINT "StoryFactOverride_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactOverride" ADD CONSTRAINT "StoryFactOverride_workspaceId_factId_fkey" FOREIGN KEY ("workspaceId", "factId") REFERENCES "StoryFact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryFactOverride" ADD CONSTRAINT "StoryFactOverride_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A book library names its book; the series library names none. One series
-- library per workspace (Prisma cannot spell a partial unique index).
ALTER TABLE "SourceLibrary" ADD CONSTRAINT "SourceLibrary_scope_book" CHECK (("scope" = 'BOOK') = ("bookId" IS NOT NULL));
CREATE UNIQUE INDEX "SourceLibrary_one_series_per_workspace" ON "SourceLibrary"("workspaceId") WHERE "scope" = 'SERIES';
-- The book is in the library's own workspace (MATCH SIMPLE: a series row's NULL book is not checked).
ALTER TABLE "SourceLibrary" ADD CONSTRAINT "SourceLibrary_workspace_book_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Source" ADD CONSTRAINT "Source_outcome_known" CHECK ("outcome" IS NULL OR "outcome" IN ('OK', 'PARTIAL', 'CEILING', 'KILL_SWITCH', 'BUDGET', 'AI_UNAVAILABLE', 'NOT_EVALUATED', 'REQUESTER_NOT_PERMITTED', 'CLAIM_EXPIRED', 'ABORTED', 'ENQUEUE_FAILED', 'INTERNAL'));
ALTER TABLE "Source" ADD CONSTRAINT "Source_counts" CHECK ("version" >= 1 AND "chunkCount" BETWEEN 1 AND 1500 AND "chunksDone" BETWEEN 0 AND "chunkCount" AND "factCount" >= 0 AND "byteLength" >= 0);
ALTER TABLE "Source" ADD CONSTRAINT "Source_amounts" CHECK ("estimateMicroUsd" >= 0 AND "worstCaseMicroUsd" >= 0 AND "budgetMicroUsd" >= 0 AND "spentMicroUsd" >= 0);
-- One source per content in a library: the same text twice is refused (409 SOURCE_DUPLICATE in the usecase, this under concurrency).
CREATE UNIQUE INDEX "Source_library_content_key" ON "Source"("workspaceId", "libraryId", "contentHash");

ALTER TABLE "SourceChunk" ADD CONSTRAINT "SourceChunk_bounds" CHECK ("position" >= 0 AND "startOffset" >= 0 AND "endOffset" >= "startOffset" AND "tokenEstimate" >= 0);

ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_predicate_known" CHECK ("predicate" IN ('ROLE', 'WANT', 'APPEARANCE', 'TRAIT', 'ABILITY', 'BACKSTORY', 'RELATIONSHIP', 'LOCATION', 'OCCUPATION', 'POSSESSION', 'AGE', 'KNOWLEDGE', 'EVENT', 'PLACE_TYPE', 'PURPOSE', 'MEMBERSHIP', 'POWER_BASE', 'RULE', 'OTHER'));
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_span" CHECK ("quoteStart" >= 0 AND "quoteEnd" > "quoteStart" AND "position" >= 0);
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_flags_known" CHECK ("flags" <@ ARRAY['POSSIBLE_INSTRUCTION']::TEXT[]);
-- A decided fact names when (and, until that person is deleted, who); a pending one neither.
ALTER TABLE "StoryFact" ADD CONSTRAINT "StoryFact_decision" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL));

-- A fact's linked elements are in its own workspace.
CREATE OR REPLACE FUNCTION story_fact_elements_in_workspace() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."subjectElementId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "BibleElement" WHERE "id" = NEW."subjectElementId" AND "workspaceId" = NEW."workspaceId") THEN
        RAISE EXCEPTION 'STORY_FACT_ELEMENT_FOREIGN: the subject element is not in this workspace' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."objectElementId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "BibleElement" WHERE "id" = NEW."objectElementId" AND "workspaceId" = NEW."workspaceId") THEN
        RAISE EXCEPTION 'STORY_FACT_ELEMENT_FOREIGN: the object element is not in this workspace' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS story_fact_elements_in_workspace ON "StoryFact";
CREATE TRIGGER story_fact_elements_in_workspace
    BEFORE INSERT OR UPDATE OF "subjectElementId", "objectElementId" ON "StoryFact"
    FOR EACH ROW EXECUTE FUNCTION story_fact_elements_in_workspace();

-- A fact is fixed once written: only its decision (status, who, when), its
-- supersession, and the element links an element's deletion clears may change.
-- What it says, what it quotes and where it comes from never do (rule 1: the
-- author decided about exactly these words).
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
       OR (NEW."subjectElementId" IS NOT NULL AND NEW."subjectElementId" IS DISTINCT FROM OLD."subjectElementId")
       OR (NEW."objectElementId" IS NOT NULL AND NEW."objectElementId" IS DISTINCT FROM OLD."objectElementId") THEN
        RAISE EXCEPTION 'STORY_FACT_FIXED: only a fact''s decision may change' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS story_fact_fixed ON "StoryFact";
CREATE TRIGGER story_fact_fixed BEFORE UPDATE ON "StoryFact" FOR EACH ROW EXECUTE FUNCTION story_fact_fixed();

-- A chunk is the vector store's second source table (subphase 2.0, D8): its
-- vectors go with it, and a vector is never written for a chunk that is gone.
DROP TRIGGER IF EXISTS "SourceChunk_vector_embedding_delete" ON "SourceChunk";
CREATE TRIGGER "SourceChunk_vector_embedding_delete"
    AFTER DELETE ON "SourceChunk" FOR EACH ROW
    EXECUTE FUNCTION vector_embedding_delete_with_source('SourceChunk');
DROP TRIGGER IF EXISTS "VectorEmbedding_source_chunk_guard" ON "VectorEmbedding";
CREATE TRIGGER "VectorEmbedding_source_chunk_guard"
    BEFORE INSERT ON "VectorEmbedding" FOR EACH ROW
    WHEN (NEW."sourceModel" = 'SourceChunk')
    EXECUTE FUNCTION vector_embedding_require_source('SourceChunk', 'SourceChunk');

ALTER TABLE "SourceLibrary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SourceLibrary" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SourceLibrary";
CREATE POLICY workspace_isolation ON "SourceLibrary"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SourceLibrary";
CREATE POLICY superuser_bypass ON "SourceLibrary"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "Source" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Source" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "Source";
CREATE POLICY workspace_isolation ON "Source"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "Source";
CREATE POLICY superuser_bypass ON "Source"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "SourceChunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SourceChunk" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "SourceChunk";
CREATE POLICY workspace_isolation ON "SourceChunk"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "SourceChunk";
CREATE POLICY superuser_bypass ON "SourceChunk"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "StoryFact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoryFact" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StoryFact";
CREATE POLICY workspace_isolation ON "StoryFact"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StoryFact";
CREATE POLICY superuser_bypass ON "StoryFact"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "BookSeriesSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookSeriesSource" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "BookSeriesSource";
CREATE POLICY workspace_isolation ON "BookSeriesSource"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "BookSeriesSource";
CREATE POLICY superuser_bypass ON "BookSeriesSource"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "StoryFactOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoryFactOverride" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StoryFactOverride";
CREATE POLICY workspace_isolation ON "StoryFactOverride"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StoryFactOverride";
CREATE POLICY superuser_bypass ON "StoryFactOverride"
    USING (current_setting('role') != 'app_user');

