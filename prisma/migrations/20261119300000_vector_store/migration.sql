-- Subphase 2.0 — the vector store: the pgvector extension and ONE
-- domain-neutral embedding table under the workspace's row-level security
-- (owner decisions D7 and D8). The CREATE TABLE, indexes and foreign keys are
-- what `prisma migrate diff` generates from prisma/schema/vector.prisma; the
-- extension, the CHECK constraints, the row-level security, the grants and
-- the delete-with-source trigger function are appended by hand.
--
--   VectorEmbedding   one embedding revision's vector of one chunk of one
--                     source row: a key, an optional book scope, a keyed
--                     content hash, the dimension count and the vector, never
--                     text. Read and written only by
--                     src/app-layer/repositories/vector/pgvector-store.ts
--                     behind src/app-layer/repositories/vector.repository.ts.
--
-- ── THE EXTENSION NEEDS A SUPERUSER ────────────────────────────────
-- pgvector's vector.control does not declare itself `trusted`, so
-- CREATE EXTENSION vector needs a superuser. Every Postgres the repository
-- runs is deploy/postgres/Dockerfile (ghcr.io/rodnapamet/inkquisitor-postgres,
-- D7), which carries the extension's files: docker-compose.yml builds it, and
-- CI builds it in the Test and E2E jobs. There, `prisma migrate deploy` runs
-- as the image's POSTGRES_USER (`postgres`), a superuser, so the statement
-- below creates the extension.
--
-- PRODUCTION: `prisma migrate deploy` runs over DIRECT_DATABASE_URL. If that
-- URL names a role that is not a superuser (a managed Postgres's admin role
-- usually is not), an operator runs, once, as a superuser and before this
-- migration:
--
--     CREATE EXTENSION IF NOT EXISTS vector;
--
-- and the statement below is then a no-op. On a managed Postgres, "the image"
-- is the provider's: it must offer pgvector 0.8.0 or later (the store's
-- probe refuses anything older, pgvector-store.ts).
--
-- ── WHY THE TABLE LOOKS LIKE THIS ──────────────────────────────────
-- `embedding` is the untyped `vector`, so one table holds every embedding
-- revision; a CHECK holds `dimensions` to vector_dims(embedding), and another
-- refuses a zero vector (it has no direction, and its cosine distance is
-- NaN). The workspace travels in the book reference, the composite
-- (workspaceId, bookId), so a vector can never be filed under another
-- workspace's book, even through a write that bypasses RLS (a foreign-key
-- check does not apply RLS to the referenced table). A vector goes with its
-- book and with its workspace (ON DELETE CASCADE).
--
-- A vector's SOURCE is polymorphic (`sourceModel`, `sourceId`), so no foreign
-- key removes a vector with its source row. `vector_embedding_delete_with_source`
-- below is the trigger function a source table attaches (2.1 and 4.1, D8):
--
--     CREATE TRIGGER "<Model>_vector_embedding_delete"
--         AFTER DELETE ON "<Model>" FOR EACH ROW
--         EXECUTE FUNCTION vector_embedding_delete_with_source('<Model>');
--
-- It deletes the deleted row's vectors in the same statement, whoever deletes
-- the row (a usecase, a cascade), as the deleting role and under its RLS.
--
-- NO HNSW INDEX YET. An HNSW index on an untyped `vector` is an expression
-- index on one cast, `("embedding"::vector(<d>))`, so it can only be built for
-- a known dimension count, and the production embedding model is chosen by
-- the subphase that first embeds author text (2.1). Until then every search
-- is an EXACT scan of one workspace's rows of one revision (optionally one
-- book's), through the (workspaceId, bookId, embeddingRevision) btree or the
-- unique key's (workspaceId, embeddingRevision) prefix: recall is 1 by
-- construction, and pgvector filters a SHARED index's results only after the
-- approximate scan, which is the case an author's small workspace beside a
-- large one would serve worst. The migration that fixes the model adds its
-- partial index (`… USING hnsw (("embedding"::vector(<d>)) vector_cosine_ops)
-- WHERE "embeddingRevision" = '<revision>'`) when a workspace's row count
-- makes exact search too slow.
--
-- `writeSeq` is drawn from the table's sequence on every write; a rebuild
-- draws its start value under an exclusive (workspace, revision) advisory lock
-- and deletes only the rows written before it, so a concurrent write is never
-- erased. app_user needs the sequence for the column default and for the
-- rebuild's nextval.

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "VectorEmbedding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT,
    "sourceModel" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "embeddingRevision" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector NOT NULL,
    "rebuildGeneration" TEXT,
    "writeSeq" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VectorEmbedding_workspaceId_sourceModel_sourceId_idx" ON "VectorEmbedding"("workspaceId", "sourceModel", "sourceId");

-- CreateIndex
CREATE INDEX "VectorEmbedding_workspaceId_bookId_embeddingRevision_idx" ON "VectorEmbedding"("workspaceId", "bookId", "embeddingRevision");

-- CreateIndex
CREATE UNIQUE INDEX "VectorEmbedding_workspaceId_embeddingRevision_sourceModel_s_key" ON "VectorEmbedding"("workspaceId", "embeddingRevision", "sourceModel", "sourceId", "chunkIndex");

-- AddForeignKey
ALTER TABLE "VectorEmbedding" ADD CONSTRAINT "VectorEmbedding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorEmbedding" ADD CONSTRAINT "VectorEmbedding_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- CHECK constraints: the repository's validation, held by the database
-- ═══════════════════════════════════════════════════════════════════
-- The same bounds as src/app-layer/repositories/vector.repository.ts and
-- vector-search-params.ts, so a write that skips the repository is refused
-- too.

ALTER TABLE "VectorEmbedding"
    ADD CONSTRAINT "VectorEmbedding_sourceModel_check" CHECK ("sourceModel" ~ '^[A-Z][A-Za-z0-9]{0,63}$'),
    ADD CONSTRAINT "VectorEmbedding_sourceId_check" CHECK ("sourceId" ~ '^[A-Za-z0-9_:.-]{1,128}$'),
    ADD CONSTRAINT "VectorEmbedding_chunkIndex_check" CHECK ("chunkIndex" BETWEEN 0 AND 100000),
    ADD CONSTRAINT "VectorEmbedding_embeddingRevision_check" CHECK ("embeddingRevision" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$'),
    ADD CONSTRAINT "VectorEmbedding_contentHash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "VectorEmbedding_dimensions_check" CHECK ("dimensions" BETWEEN 1 AND 4096),
    ADD CONSTRAINT "VectorEmbedding_dims_match" CHECK (vector_dims("embedding") = "dimensions"),
    ADD CONSTRAINT "VectorEmbedding_nonzero" CHECK (vector_norm("embedding") > 0);

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the set every workspace-scoped table carries
-- ═══════════════════════════════════════════════════════════════════
--
-- RLS enabled and FORCED, ONE `workspace_isolation` policy with USING and
-- WITH CHECK on the same predicate, and `superuser_bypass` for every role but
-- app_user (docs/rls-workspace-isolation.md). tests/guards/rls-migration-coverage.test.ts
-- compares these statements exactly; tests/integration/rls-coverage.test.ts
-- compares what PostgreSQL stored and proves they isolate.

GRANT SELECT, INSERT, UPDATE, DELETE ON "VectorEmbedding" TO app_user;
GRANT USAGE, SELECT ON SEQUENCE "VectorEmbedding_writeSeq_seq" TO app_user;

ALTER TABLE "VectorEmbedding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VectorEmbedding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "VectorEmbedding";
CREATE POLICY workspace_isolation ON "VectorEmbedding"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "VectorEmbedding";
CREATE POLICY superuser_bypass ON "VectorEmbedding"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- A source row's vectors go with it
-- ═══════════════════════════════════════════════════════════════════
--
-- Attached by each source table's own migration (see the header). The source
-- model is the trigger's ONE argument, named explicitly rather than read from
-- TG_TABLE_NAME, because a model's table name may differ from its name
-- (`@@map`) and `sourceModel` holds the model's name. VOLATILE and SECURITY
-- INVOKER (the defaults): it deletes as the deleting role, so under app_user
-- the workspace_isolation policy confines it to the deleted row's workspace,
-- which is the only workspace it names.

CREATE OR REPLACE FUNCTION vector_embedding_delete_with_source() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
    IF TG_NARGS <> 1 OR TG_ARGV[0] !~ '^[A-Z][A-Za-z0-9]{0,63}$' THEN
        RAISE EXCEPTION 'VECTOR_SOURCE_TRIGGER_MISCONFIGURED: the trigger on % must name its source model', TG_TABLE_NAME
            USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM "VectorEmbedding"
     WHERE "workspaceId" = OLD."workspaceId"
       AND "sourceModel" = TG_ARGV[0]
       AND "sourceId" = OLD."id";
    RETURN OLD;
END
$$;
