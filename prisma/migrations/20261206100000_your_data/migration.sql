-- Phase 5.H-a — the author's data (decision D36 and issue #71).
--
--   1  ManuscriptScene.deletedAt   a deleted scene is SOFT for 30 days (restorable with its text, notes, card, links,
--                                  versions and research proposals), then purged by the daily `scene-purge` job; the
--                                  database refuses any earlier hard delete (as `book_delete_only_when_purge_due` does
--                                  for books) and stamps `deletedAt` with its own clock for app_user
--   2  a live scene's place        the unique (chapterId, rank) becomes a PARTIAL unique index over live scenes: a
--                                  deleted scene keeps its old rank, which a live one may take meanwhile (a restore
--                                  goes back to its place when it is free, else to the end of its chapter)
--   3  Workspace.deletedAt         the whole workspace deleted SOFT for 30 days (an OWNER restores it), then the daily
--                                  `workspace-purge` job deletes it and everything it holds; app_user never deletes a
--                                  workspace row, and `deletedAt` is the database's clock for app_user
--
-- No new table, so no new row-level security policy: the columns ride their tables' existing ones.

-- AlterTable
ALTER TABLE "ManuscriptScene" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "purgeAccountOfId" TEXT;

-- ─── 2. A live scene's place ──────────────────────────────────────────────
-- DropIndex
DROP INDEX "ManuscriptScene_chapterId_rank_key";

-- Prisma cannot spell a partial unique index (the schema carries the plain index for the foreign key and the reads):
-- never add a `@@unique` for it.
CREATE UNIQUE INDEX "ManuscriptScene_chapterId_rank_live_key" ON "ManuscriptScene"("chapterId", "rank") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "ManuscriptScene_chapterId_rank_idx" ON "ManuscriptScene"("chapterId", "rank");

-- CreateIndex
CREATE INDEX "ManuscriptScene_workspaceId_bookId_deletedAt_idx" ON "ManuscriptScene"("workspaceId", "bookId", "deletedAt");

-- CreateIndex
CREATE INDEX "ManuscriptScene_deletedAt_idx" ON "ManuscriptScene"("deletedAt");

-- CreateIndex
CREATE INDEX "Workspace_deletedAt_idx" ON "Workspace"("deletedAt");

-- CreateIndex
CREATE INDEX "Workspace_deletedById_idx" ON "Workspace"("deletedById");

-- CreateIndex
CREATE INDEX "Workspace_purgeAccountOfId_idx" ON "Workspace"("purgeAccountOfId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_purgeAccountOfId_fkey" FOREIGN KEY ("purgeAccountOfId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A deletion names who asked, and only a deleted workspace names an account to delete with it.
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_purge_account_only_when_deleted" CHECK ("purgeAccountOfId" IS NULL OR "deletedAt" IS NOT NULL);

-- ═══════════════════════════════════════════════════════════════════
-- 1. A scene is deleted for good only by its purge
-- ═══════════════════════════════════════════════════════════════════
--
-- Deleting a scene is soft: `deletedAt` is set, and the author (`bible.edit`) may restore it for 30 days
-- (`SCENE_RESTORE_DAYS`, src/lib/manuscript/scene-retention.ts; tests/unit/manuscript/scene-retention.test.ts holds the
-- two numbers equal). The row — and with it everything that cascades from it: its links, card, research proposals,
-- draft facts and their mismatches, thread links, interview sessions — goes only after that, so the database refuses,
-- for EVERY role, the DELETE of a scene that is live or still restorable (P0001, message prefix SCENE_DELETE_NOT_DUE).
--
-- One delete passes besides the purge's: the CASCADE of the scene's chapter (a chapter, part or manuscript deleted,
-- the book purged, the workspace purged), which the trigger recognises by the chapter row being gone already (a
-- cascade deletes the parent first, then its children). Keep the function VOLATILE: each check reads a fresh snapshot.
--
-- `deletedAt` is a `timestamp` WITHOUT time zone holding UTC (Prisma's convention), compared with the current UTC time
-- as the same type, never with `now()` itself (the session's zone would move the window; 1.H's note).

CREATE OR REPLACE FUNCTION manuscript_scene_delete_only_when_purge_due() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "ManuscriptChapter" WHERE "id" = OLD."chapterId") THEN
        RETURN OLD;
    END IF;
    IF OLD."deletedAt" IS NOT NULL AND OLD."deletedAt" <= (now() AT TIME ZONE 'UTC') - interval '30 days' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'SCENE_DELETE_NOT_DUE: a scene is deleted for good only 30 days after it was deleted'
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS manuscript_scene_delete_only_when_purge_due ON "ManuscriptScene";
CREATE TRIGGER manuscript_scene_delete_only_when_purge_due
    BEFORE DELETE ON "ManuscriptScene"
    FOR EACH ROW EXECUTE FUNCTION manuscript_scene_delete_only_when_purge_due();

-- For app_user a newly set `deletedAt` is the DATABASE's clock (as `book_deleted_at_is_now`, 2.H): an app server's
-- clock, or a value a caller chose, never starts the window. The superuser (tests backdating a deletion) is left alone.
CREATE OR REPLACE FUNCTION manuscript_scene_deleted_at_is_now() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF current_setting('role') <> 'app_user' OR NEW."deletedAt" IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt" THEN
            RETURN NEW;
        END IF;
    END IF;
    NEW."deletedAt" := (now() AT TIME ZONE 'UTC');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manuscript_scene_deleted_at_is_now ON "ManuscriptScene";
CREATE TRIGGER manuscript_scene_deleted_at_is_now
    BEFORE INSERT OR UPDATE OF "deletedAt" ON "ManuscriptScene"
    FOR EACH ROW EXECUTE FUNCTION manuscript_scene_deleted_at_is_now();

-- ═══════════════════════════════════════════════════════════════════
-- 3. A workspace is deleted for good only by its purge
-- ═══════════════════════════════════════════════════════════════════
--
-- An OWNER's deletion is soft (`deletedAt`); the daily `workspace-purge` job deletes the row 30 days later, OUTSIDE
-- row-level security, and its cascade takes everything the workspace holds (the audit trail excepted: it has no
-- foreign key, by design, and outlives the workspace — docs/your-data.md). So app_user, which every request and job
-- runs as, never deletes a workspace row at all (P0001, WORKSPACE_DELETE_BY_PURGE_ONLY), and the window is the
-- database's clock (the stamp below). The owning role is not refused: the purge, and test teardowns, delete as it.

CREATE OR REPLACE FUNCTION workspace_delete_by_purge_only() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF current_setting('role') = 'app_user' THEN
        RAISE EXCEPTION 'WORKSPACE_DELETE_BY_PURGE_ONLY: a workspace is deleted for good only by its purge'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS workspace_delete_by_purge_only ON "Workspace";
CREATE TRIGGER workspace_delete_by_purge_only
    BEFORE DELETE ON "Workspace"
    FOR EACH ROW EXECUTE FUNCTION workspace_delete_by_purge_only();

CREATE OR REPLACE FUNCTION workspace_deleted_at_is_now() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF current_setting('role') <> 'app_user' OR NEW."deletedAt" IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt" THEN
            RETURN NEW;
        END IF;
    END IF;
    NEW."deletedAt" := (now() AT TIME ZONE 'UTC');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_deleted_at_is_now ON "Workspace";
CREATE TRIGGER workspace_deleted_at_is_now
    BEFORE INSERT OR UPDATE OF "deletedAt" ON "Workspace"
    FOR EACH ROW EXECUTE FUNCTION workspace_deleted_at_is_now();

-- ═══════════════════════════════════════════════════════════════════
-- 4. A purged scene's history goes with it (issue #71, item 2)
-- ═══════════════════════════════════════════════════════════════════
--
-- A scene's text, note and card versions are keyed to its BOOK with no foreign key to the scene (5.1: the history
-- outlives a hard-deleted scene). Since 5.H-a a scene is deleted for good only by its purge, and the owner decided its
-- history goes with it. The append-only trigger (5.1, shared by SceneVersion, SceneNoteVersion and SceneCardVersion)
-- gains one more admitted DELETE: the scene row is already gone AND the transaction names that very scene in the
-- `inkquisitor.scene_purge` setting (set by `SceneHistoryRepository.deleteForGoneScene`, transaction-local) — so a
-- version is never deleted while its scene stands, and only by the purge's own statement. Everything else is
-- unchanged: the book's cascade, and the one clearing of an author who was deleted.

CREATE OR REPLACE FUNCTION scene_version_append_only() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "Book" WHERE "id" = OLD."bookId") THEN
            RETURN OLD;
        END IF;
        IF current_setting('inkquisitor.scene_purge', true) = OLD."sceneId"
           AND NOT EXISTS (SELECT 1 FROM "ManuscriptScene" WHERE "id" = OLD."sceneId") THEN
            RETURN OLD;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD."authorId" IS NOT NULL
           AND NEW."authorId" IS NULL
           AND (to_jsonb(NEW) - 'authorId') = (to_jsonb(OLD) - 'authorId')
           AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."authorId") THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'SCENE_VERSION_APPEND_ONLY: % of % refused', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'P0001';
END;
$$;
