-- Phase 1.H — hardening the book bible.
--
--   * Book.deletedAt: a deleted book is hidden at once and restorable by its
--     workspace's OWNER for 30 days; the daily `book-purge` job then deletes
--     the row, and with it (by cascade) its elements, fields, relations,
--     version history and vectors. The version table's append-only trigger
--     (20261119200000_bible_model) admits those deletes because the book is
--     already gone when it runs.
--   * Indexes for every list query (tests/guards/schema-index-coverage.test.ts):
--     the recently-deleted list (workspaceId, deletedAt), the purge's scan
--     across workspaces (deletedAt), and the board's per-kind pages, which
--     read a book's elements of one kind by name (workspaceId, bookId, kind,
--     name) — that index replaces (workspaceId, bookId, kind), its prefix.

-- AlterTable
ALTER TABLE "Book" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- DropIndex
DROP INDEX "BibleElement_workspaceId_bookId_kind_idx";

-- CreateIndex
CREATE INDEX "Book_workspaceId_deletedAt_idx" ON "Book"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "Book_deletedAt_idx" ON "Book"("deletedAt");

-- CreateIndex
CREATE INDEX "BibleElement_workspaceId_bookId_kind_name_idx" ON "BibleElement"("workspaceId", "bookId", "kind", "name");

-- ═══════════════════════════════════════════════════════════════════
-- A book is deleted for good only by its purge
-- ═══════════════════════════════════════════════════════════════════
--
-- Deleting a book is soft: `deletedAt` is set, and the workspace's OWNER may
-- restore it for 30 days (`BOOK_RESTORE_DAYS`, src/lib/bible/book-retention.ts;
-- tests/unit/bible/book-retention.test.ts holds the two numbers equal). The
-- row, and with it the book's whole version history, goes only after that, so
-- the database refuses, for EVERY role, the DELETE of a book that is live or
-- still restorable (P0001, message prefix BOOK_DELETE_NOT_DUE).
--
-- One delete passes besides the purge's: the cascade of the book's workspace,
-- which the trigger recognises by the workspace row being gone already (as the
-- version table's append-only trigger recognises its book's). Keep the
-- function VOLATILE: each check reads a fresh snapshot.

CREATE OR REPLACE FUNCTION book_delete_only_when_purge_due() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = OLD."workspaceId") THEN
        RETURN OLD;
    END IF;
    IF OLD."deletedAt" IS NOT NULL AND OLD."deletedAt" <= now() - interval '30 days' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'BOOK_DELETE_NOT_DUE: a book is deleted for good only 30 days after it was deleted'
        USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS book_delete_only_when_purge_due ON "Book";
CREATE TRIGGER book_delete_only_when_purge_due
    BEFORE DELETE ON "Book"
    FOR EACH ROW EXECUTE FUNCTION book_delete_only_when_purge_due();
