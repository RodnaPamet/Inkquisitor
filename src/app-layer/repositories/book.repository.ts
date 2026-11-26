/**
 * Books. Workspace-scoped: every query runs inside `runInWorkspaceContext`
 * (the `workspace_isolation` policy) AND filters by `workspaceId` (defence in
 * depth). No authorization here; the usecases ask first.
 *
 * `logline` is encrypted at rest by the field-encryption extension; this
 * module reads and writes plaintext and never filters on it.
 *
 * A DELETED BOOK (`deletedAt` set, Phase 1.H) is invisible to every read and
 * write here but the recently-deleted ones (`listDeleted`, `restore`) and the
 * purge's (`listPurgeDue`, `lockPurgeDue`, `purge`): `find` and `list` carry
 * `deletedAt: null`, so every usecase that starts from `requireBook` answers
 * 404 for it.
 */
import type { BookStage, Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

export const BOOK_SELECT = {
    id: true,
    title: true,
    logline: true,
    genre: true,
    audience: true,
    targetLength: true,
    stage: true,
    createdAt: true,
    updatedAt: true,
} as const satisfies Prisma.BookSelect;

export interface BookWrite {
    title?: string;
    logline?: string | null;
    genre?: string | null;
    audience?: string | null;
    targetLength?: number | null;
    stage?: BookStage;
}

export const BookRepository = {
    /**
     * Serialise every bundle import into one book (Phase 1.3): a
     * transaction-scoped advisory lock, held to commit, so two imports of
     * one book queue rather than race for the same slugs.
     */
    async lockForImport(db: Db, bookId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bible-import:' + bookId}))`;
    },

    /** The workspace's live books, most recently updated first (`take` of them). */
    list(db: Db, workspaceId: string, take: number) {
        return db.book.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take, select: BOOK_SELECT });
    },

    /** A live book of the workspace; a deleted one is not found. */
    find(db: Db, workspaceId: string, bookId: string) {
        return db.book.findFirst({ where: { id: bookId, workspaceId, deletedAt: null }, select: BOOK_SELECT });
    },

    /**
     * A live book of the workspace, its row held FOR SHARE to commit (4.H-a, #57 item 4): a write that hangs rows off
     * the book (a source library) re-checks the book IN ITS OWN transaction, and a soft delete (an UPDATE) waits for
     * it, so the write never lands under a book deleted between an earlier check and it.
     */
    async findLiveForShare(db: Db, workspaceId: string, bookId: string): Promise<boolean> {
        const rows = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Book" WHERE id = ${bookId} AND "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL FOR SHARE`;
        return rows.length === 1;
    },

    /** The workspace's books deleted after `since` (still restorable), newest deletion first. */
    listDeleted(db: Db, workspaceId: string, since: Date, take: number) {
        return db.book.findMany({
            where: { workspaceId, deletedAt: { gt: since } },
            orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
            take,
            select: { id: true, title: true, deletedAt: true },
        });
    },

    /** Mark a live book deleted; 1 when it was. */
    async softDelete(db: Db, workspaceId: string, bookId: string, at: Date) {
        const res = await db.book.updateMany({ where: { id: bookId, workspaceId, deletedAt: null }, data: { deletedAt: at } });
        return res.count;
    },

    /** Bring back a book deleted after `since`; 1 when it was. */
    async restore(db: Db, workspaceId: string, bookId: string, since: Date) {
        const res = await db.book.updateMany({ where: { id: bookId, workspaceId, deletedAt: { gt: since } }, data: { deletedAt: null } });
        return res.count;
    },

    /**
     * Books of EVERY workspace deleted at or before `cutoff`, oldest first (the
     * purge's discovery; the caller holds a row-level-security bypass).
     */
    listPurgeDue(db: Db, cutoff: Date, take: number) {
        return db.book.findMany({
            where: { deletedAt: { lte: cutoff } },
            orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
            take,
            select: { id: true, workspaceId: true },
        });
    },

    /** Lock a book that is due for purge (deleted at or before `cutoff`) to commit; false when it is not (restored, or gone). */
    async lockPurgeDue(db: Db, workspaceId: string, bookId: string, cutoff: Date): Promise<boolean> {
        const rows = await db.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Book" WHERE "id" = ${bookId} AND "workspaceId" = ${workspaceId} AND "deletedAt" <= ${cutoff} FOR UPDATE`;
        return rows.length === 1;
    },

    /**
     * Delete a book due for purge, for good: its elements, fields, relations,
     * versions and vectors go by cascade. Only a book deleted at or before
     * `cutoff`: a live or restorable book is never purged here.
     */
    async purge(db: Db, workspaceId: string, bookId: string, cutoff: Date) {
        const res = await db.book.deleteMany({ where: { id: bookId, workspaceId, deletedAt: { lte: cutoff } } });
        return res.count;
    },

    create(db: Db, workspaceId: string, data: BookWrite & { title: string }) {
        return db.book.create({ data: { ...data, workspaceId }, select: BOOK_SELECT });
    },

    async update(db: Db, workspaceId: string, bookId: string, data: BookWrite) {
        const res = await db.book.updateMany({ where: { id: bookId, workspaceId, deletedAt: null }, data });
        return res.count;
    },

    /** What a book holds, for the deletion's audit row (counts only). */
    async contents(db: Db, workspaceId: string, bookId: string) {
        // One after another: a transaction's client runs one query at a time.
        const elements = await db.bibleElement.count({ where: { workspaceId, bookId } });
        const relations = await db.bibleRelation.count({ where: { workspaceId, bookId } });
        const versions = await db.bibleEntryVersion.count({ where: { workspaceId, bookId } });
        return { elements, relations, versions };
    },
};
