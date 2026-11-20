-- Phase 3.1 — the story canvas platform: a book's story maps (at most one of
-- each kind, decision D18), the bible elements and relations drawn on them,
-- and one snapshot per save.
--
--   StoryMap     one per (book, kind); the optimistic-lock version and the
--                renderer's freeform layer (encrypted by the application).
--   MapNode      one BibleElement drawn on a map, at most once per map.
--   MapEdge      one BibleRelation drawn on a map, at most once per map.
--   MapSnapshot  the map as a save left it (encrypted), append-only.
--
-- The tables, indexes and foreign keys are what `prisma migrate diff`
-- generates from prisma/schema/ (with BibleRelation's new (bookId, id) key,
-- which a map edge references); the CHECKs, the row-level security, the
-- append-only trigger and the version bump on a bible cascade are appended by
-- hand below.
--
-- ROLLING-DEPLOY SAFETY. Forward-only and additive: new tables the previous
-- image never reads or writes, and a unique index on BibleRelation over a key
-- that already includes its primary key (so no existing row can violate it).


-- CreateEnum
CREATE TYPE "StoryMapKind" AS ENUM ('RELATIONSHIP', 'PLOT', 'TIMELINE');

-- CreateTable
CREATE TABLE "StoryMap" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "kind" "StoryMapKind" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "freeformJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MapNode" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "bibleElementId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "w" DOUBLE PRECISION NOT NULL,
    "h" DOUBLE PRECISION NOT NULL,
    "lane" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MapNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MapEdge" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "bibleRelationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MapEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MapSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "nodeCount" INTEGER NOT NULL,
    "edgeCount" INTEGER NOT NULL,
    "restoredFromVersion" INTEGER,
    "fromBibleDeletion" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MapSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoryMap_bookId_kind_key" ON "StoryMap"("bookId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "StoryMap_workspaceId_id_key" ON "StoryMap"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StoryMap_workspaceId_bookId_id_key" ON "StoryMap"("workspaceId", "bookId", "id");

-- CreateIndex
CREATE INDEX "MapNode_workspaceId_bookId_mapId_idx" ON "MapNode"("workspaceId", "bookId", "mapId");

-- CreateIndex
CREATE INDEX "MapNode_bookId_bibleElementId_idx" ON "MapNode"("bookId", "bibleElementId");

-- CreateIndex
CREATE UNIQUE INDEX "MapNode_mapId_bibleElementId_key" ON "MapNode"("mapId", "bibleElementId");

-- CreateIndex
CREATE INDEX "MapEdge_workspaceId_bookId_mapId_idx" ON "MapEdge"("workspaceId", "bookId", "mapId");

-- CreateIndex
CREATE INDEX "MapEdge_bookId_bibleRelationId_idx" ON "MapEdge"("bookId", "bibleRelationId");

-- CreateIndex
CREATE UNIQUE INDEX "MapEdge_mapId_bibleRelationId_key" ON "MapEdge"("mapId", "bibleRelationId");

-- CreateIndex
CREATE INDEX "MapSnapshot_workspaceId_mapId_version_idx" ON "MapSnapshot"("workspaceId", "mapId", "version");

-- CreateIndex
CREATE INDEX "MapSnapshot_createdById_idx" ON "MapSnapshot"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "MapSnapshot_mapId_version_key" ON "MapSnapshot"("mapId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BibleRelation_bookId_id_key" ON "BibleRelation"("bookId", "id");

-- AddForeignKey
ALTER TABLE "StoryMap" ADD CONSTRAINT "StoryMap_workspaceId_bookId_fkey" FOREIGN KEY ("workspaceId", "bookId") REFERENCES "Book"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MapNode" ADD CONSTRAINT "MapNode_workspaceId_bookId_mapId_fkey" FOREIGN KEY ("workspaceId", "bookId", "mapId") REFERENCES "StoryMap"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MapNode" ADD CONSTRAINT "MapNode_bookId_bibleElementId_fkey" FOREIGN KEY ("bookId", "bibleElementId") REFERENCES "BibleElement"("bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MapEdge" ADD CONSTRAINT "MapEdge_workspaceId_bookId_mapId_fkey" FOREIGN KEY ("workspaceId", "bookId", "mapId") REFERENCES "StoryMap"("workspaceId", "bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MapEdge" ADD CONSTRAINT "MapEdge_bookId_bibleRelationId_fkey" FOREIGN KEY ("bookId", "bibleRelationId") REFERENCES "BibleRelation"("bookId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MapSnapshot" ADD CONSTRAINT "MapSnapshot_workspaceId_mapId_fkey" FOREIGN KEY ("workspaceId", "mapId") REFERENCES "StoryMap"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MapSnapshot" ADD CONSTRAINT "MapSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: workspace-scoped, as every book table
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "StoryMap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoryMap" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "StoryMap";
CREATE POLICY workspace_isolation ON "StoryMap"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "StoryMap";
CREATE POLICY superuser_bypass ON "StoryMap"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "MapNode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MapNode" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "MapNode";
CREATE POLICY workspace_isolation ON "MapNode"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "MapNode";
CREATE POLICY superuser_bypass ON "MapNode"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "MapEdge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MapEdge" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "MapEdge";
CREATE POLICY workspace_isolation ON "MapEdge"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "MapEdge";
CREATE POLICY superuser_bypass ON "MapEdge"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "MapSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MapSnapshot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "MapSnapshot";
CREATE POLICY workspace_isolation ON "MapSnapshot"
    USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
    WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "MapSnapshot";
CREATE POLICY superuser_bypass ON "MapSnapshot"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- Shape
-- ═══════════════════════════════════════════════════════════════════
--
-- The bounds `src/app-layer/schemas/canvas.ts` asks too: finite coordinates
-- within ±10,000,000 page units (a double admits NaN and Infinity, which
-- would break every consumer that lays the map out), a size of 8..100,000,
-- and a lane that is a key, never text. A version starts at 1 and a snapshot
-- names a version the map reached.

ALTER TABLE "StoryMap" ADD CONSTRAINT "StoryMap_shape"
    CHECK ("version" >= 1);

ALTER TABLE "MapNode" ADD CONSTRAINT "MapNode_shape"
    CHECK ("x" BETWEEN -10000000 AND 10000000
       AND "y" BETWEEN -10000000 AND 10000000
       AND "w" BETWEEN 8 AND 100000
       AND "h" BETWEEN 8 AND 100000
       AND ("lane" IS NULL OR "lane" ~ '^[A-Za-z0-9._:-]{1,128}$'));

ALTER TABLE "MapSnapshot" ADD CONSTRAINT "MapSnapshot_shape"
    CHECK ("version" >= 1
       AND "nodeCount" >= 0 AND "edgeCount" >= 0
       AND ("restoredFromVersion" IS NULL OR ("restoredFromVersion" >= 1 AND "restoredFromVersion" < "version"))
       AND NOT ("fromBibleDeletion" AND "restoredFromVersion" IS NOT NULL));

-- ═══════════════════════════════════════════════════════════════════
-- MapSnapshot is append-only
-- ═══════════════════════════════════════════════════════════════════
--
-- A map's history is what it looked like after each save; nothing rewrites
-- it. app_user may read and insert; it holds no UPDATE, DELETE or TRUNCATE,
-- and the trigger below refuses UPDATE and DELETE for every role (P0001,
-- prefix MAP_SNAPSHOT_APPEND_ONLY) and TRUNCATE, as BibleEntryVersion's does.
-- Two writes pass, both the database's own referential actions:
--
--   * the DELETE its map's cascade makes (the map goes with its book, or its
--     workspace): by then the map row is gone, which is what the check reads;
--   * the UPDATE that clears `createdById` when that person's account is
--     deleted (ON DELETE SET NULL), only that column, from a user who no
--     longer exists.
--
-- Keep the function VOLATILE: each check reads a fresh snapshot.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "MapSnapshot" FROM app_user;

CREATE OR REPLACE FUNCTION map_snapshot_append_only() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "StoryMap" WHERE "id" = OLD."mapId") THEN
            RETURN OLD;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD."createdById" IS NOT NULL
           AND NEW."createdById" IS NULL
           AND (to_jsonb(NEW) - 'createdById') = (to_jsonb(OLD) - 'createdById')
           AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."createdById") THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'MAP_SNAPSHOT_APPEND_ONLY: % of MapSnapshot refused', TG_OP
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS map_snapshot_no_update_delete ON "MapSnapshot";
CREATE TRIGGER map_snapshot_no_update_delete
    BEFORE UPDATE OR DELETE ON "MapSnapshot"
    FOR EACH ROW EXECUTE FUNCTION map_snapshot_append_only();

CREATE OR REPLACE FUNCTION map_snapshot_no_truncate() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    RAISE EXCEPTION 'MAP_SNAPSHOT_APPEND_ONLY: TRUNCATE of MapSnapshot refused'
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS map_snapshot_no_truncate ON "MapSnapshot";
CREATE TRIGGER map_snapshot_no_truncate
    BEFORE TRUNCATE ON "MapSnapshot"
    FOR EACH STATEMENT EXECUTE FUNCTION map_snapshot_no_truncate();

-- ═══════════════════════════════════════════════════════════════════
-- A bible deletion moves the map's version, once, and is a snapshot
-- ═══════════════════════════════════════════════════════════════════
--
-- Deleting an element or a relation cascades to its nodes and edges: the map
-- is a picture of the bible, and the author must not hunt through three maps
-- before deleting an entry. But a canvas open in another tab still holds the
-- old picture, and its next save would draw the deleted node back (a 400
-- naming an unknown element at best). So a node or edge removed BY A CASCADE
-- bumps its map's version, and that tab's save is refused 409 like any other
-- stale save: it reloads and sees the map as the bible now stands.
--
-- A cascade is told apart by what it leaves behind: by the time a node's or
-- an edge's delete trigger runs for a cascade, the element or relation it
-- drew is already gone (as the append-only triggers read a vanished parent).
-- The map's own save deletes its nodes and edges while their element and
-- relation still exist, and moves the version itself, conditionally, exactly
-- once. When the map itself is going (its book's or workspace's cascade) the
-- UPDATE finds no row and does nothing. (`pg_trigger_depth()` cannot tell them
-- apart: a cascaded delete's row triggers fire at depth 1, measured.)
--
-- ONCE PER TRANSACTION (decision D20). One deletion can take a node and
-- several edges; the version moves once for all of them, recorded in a
-- transaction-local setting keyed by the map, so the deletion is ONE version.
--
-- EVERY VERSION HAS ITS SNAPSHOT (decision D20: history never skips a
-- version). The snapshot is encrypted by the application, which a trigger
-- cannot do, so the deleting usecase writes it in the same transaction
-- (`recordMapsAfterBibleDeletion`, under every map lock of the book, taken
-- BEFORE the delete so no save interleaves), and the deferred constraint
-- trigger below refuses, at commit, a map left at a version with no snapshot.
-- A map gone by then (its book's purge) is not asked.
--
-- Concurrency with a save: the deleting usecase takes the book's map locks
-- before the element's or relation's row, and a save takes its map's lock
-- before any row, so the two never hold each other's rows: no deadlock, and
-- the deletion's snapshot is exactly the state at its version.

CREATE OR REPLACE FUNCTION map_bump_once_for_cascade(map_id TEXT) RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    marker TEXT := 'inkquisitor.map_cascade_' || md5(map_id);
BEGIN
    IF current_setting(marker, true) IS DISTINCT FROM txid_current()::text THEN
        UPDATE "StoryMap" SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = map_id;
        PERFORM set_config(marker, txid_current()::text, true);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION map_node_bump_on_cascade() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "BibleElement" WHERE "id" = OLD."bibleElementId") THEN
        PERFORM map_bump_once_for_cascade(OLD."mapId");
    END IF;
    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION map_edge_bump_on_cascade() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "BibleRelation" WHERE "id" = OLD."bibleRelationId") THEN
        PERFORM map_bump_once_for_cascade(OLD."mapId");
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS map_node_bump_on_cascade ON "MapNode";
CREATE TRIGGER map_node_bump_on_cascade
    AFTER DELETE ON "MapNode"
    FOR EACH ROW EXECUTE FUNCTION map_node_bump_on_cascade();

DROP TRIGGER IF EXISTS map_edge_bump_on_cascade ON "MapEdge";
CREATE TRIGGER map_edge_bump_on_cascade
    AFTER DELETE ON "MapEdge"
    FOR EACH ROW EXECUTE FUNCTION map_edge_bump_on_cascade();

CREATE OR REPLACE FUNCTION story_map_version_has_snapshot() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "StoryMap" WHERE "id" = NEW."id")
       AND NOT EXISTS (SELECT 1 FROM "MapSnapshot" WHERE "mapId" = NEW."id" AND "version" = NEW."version") THEN
        RAISE EXCEPTION 'MAP_VERSION_WITHOUT_SNAPSHOT: story map % reached version % with no snapshot', NEW."id", NEW."version"
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS story_map_version_has_snapshot_insert ON "StoryMap";
CREATE CONSTRAINT TRIGGER story_map_version_has_snapshot_insert
    AFTER INSERT ON "StoryMap"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION story_map_version_has_snapshot();

DROP TRIGGER IF EXISTS story_map_version_has_snapshot_update ON "StoryMap";
CREATE CONSTRAINT TRIGGER story_map_version_has_snapshot_update
    AFTER UPDATE OF "version" ON "StoryMap"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD."version" IS DISTINCT FROM NEW."version")
    EXECUTE FUNCTION story_map_version_has_snapshot();
