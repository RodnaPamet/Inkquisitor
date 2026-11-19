/**
 * Books. Workspace-scoped: every query runs inside `runInWorkspaceContext`
 * (the `workspace_isolation` policy) AND filters by `workspaceId` (defence in
 * depth). No authorization here; the usecases ask first.
 *
 * `logline` is encrypted at rest by the field-encryption extension; this
 * module reads and writes plaintext and never filters on it.
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
    list(db: Db, workspaceId: string, take = 200) {
        return db.book.findMany({ where: { workspaceId }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take, select: BOOK_SELECT });
    },

    find(db: Db, workspaceId: string, bookId: string) {
        return db.book.findFirst({ where: { id: bookId, workspaceId }, select: BOOK_SELECT });
    },

    create(db: Db, workspaceId: string, data: BookWrite & { title: string }) {
        return db.book.create({ data: { ...data, workspaceId }, select: BOOK_SELECT });
    },

    async update(db: Db, workspaceId: string, bookId: string, data: BookWrite) {
        const res = await db.book.updateMany({ where: { id: bookId, workspaceId }, data });
        return res.count;
    },

    async remove(db: Db, workspaceId: string, bookId: string) {
        const res = await db.book.deleteMany({ where: { id: bookId, workspaceId } });
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
