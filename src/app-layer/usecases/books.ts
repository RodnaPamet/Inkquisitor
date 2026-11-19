/**
 * Books: list, read, create, change, delete (Phase 1.1).
 *
 * Every call asks its permission of the context first (`bible.view` to read,
 * `bible.edit` to write; `assertPermission` audits a refusal), then runs inside
 * `runInWorkspaceContext` as app_user under the workspace's row-level
 * security. Author text is sanitised here before it is stored
 * (`requiredLine` / `optionalLine` / `optionalBlock`, over
 * `sanitizePlainText`); the logline is encrypted at rest by the extension.
 * Every change writes an audit row in the same transaction, carrying ids and
 * counts only.
 *
 * DELETING A BOOK IS SOFT (Phase 1.H), and the workspace's OWNER's alone
 * (`books.delete`): `deleteBook` sets `deletedAt`, which hides the book from
 * every list and makes every route under it a 404 (`requireBook` reads live
 * books only). For `BOOK_RESTORE_DAYS` (30) the OWNER may list it
 * (`listDeletedBooks`) and bring it back (`restoreBook`), whole; after that
 * the daily `book-purge` job (`book-purge.ts`) deletes it and everything in
 * it — elements, fields, relations, the version history (the append-only
 * trigger admits a version's deletion only once its book is gone) and its
 * vectors.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BookRepository, type BookWrite } from '@/app-layer/repositories/book.repository';
import {
    BOOK_LABEL_MAX,
    BOOK_LOGLINE_MAX,
    BOOK_TITLE_MAX,
    BookCreateInput,
    BookUpdateInput,
} from '@/app-layer/schemas/bible';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { NotFoundError } from '@/lib/errors/types';
import { restorableUntil, restoreCutoff } from '@/lib/bible/book-retention';
import { optionalBlock, optionalLine, requireBook, requiredLine } from './bible-common';

export interface BookView {
    id: string;
    title: string;
    logline: string | null;
    genre: string | null;
    audience: string | null;
    targetLength: number | null;
    stage: string;
    createdAt: string;
    updatedAt: string;
}

type BookRow = Awaited<ReturnType<typeof BookRepository.find>> & object;

function toView(b: BookRow): BookView {
    return {
        id: b.id,
        title: b.title,
        logline: b.logline,
        genre: b.genre,
        audience: b.audience,
        targetLength: b.targetLength,
        stage: b.stage,
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
    };
}

/** The sanitised write: each text value through the plain-text sanitiser, bounds checked after. (The bundle import applies book.md through it too.) */
export function bookWrite(input: BookUpdateInput): BookWrite {
    return {
        ...(input.title !== undefined ? { title: requiredLine(input.title, BOOK_TITLE_MAX, 'Title') } : {}),
        ...(input.logline !== undefined ? { logline: optionalBlock(input.logline, BOOK_LOGLINE_MAX, 'Logline') } : {}),
        ...(input.genre !== undefined ? { genre: optionalLine(input.genre, BOOK_LABEL_MAX, 'Genre') } : {}),
        ...(input.audience !== undefined ? { audience: optionalLine(input.audience, BOOK_LABEL_MAX, 'Audience') } : {}),
        ...(input.targetLength !== undefined ? { targetLength: input.targetLength } : {}),
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
    };
}

/** Books listed at most; the list reads one more, so a cut list says so (`truncated`). */
export const BOOK_LIST_MAX = 200;

export interface BookListView {
    books: BookView[];
    /** True when the workspace holds more live books than the list shows (the most recently updated `BOOK_LIST_MAX`). */
    truncated: boolean;
}

export async function listBooks(ctx: WorkspaceRequestContext): Promise<BookListView> {
    await assertPermission(ctx, 'bible.view');
    const rows = await runInWorkspaceContext(ctx, (db) => BookRepository.list(db, ctx.workspaceId, BOOK_LIST_MAX + 1));
    return { books: rows.slice(0, BOOK_LIST_MAX).map(toView), truncated: rows.length > BOOK_LIST_MAX };
}

export async function getBook(ctx: WorkspaceRequestContext, bookId: string): Promise<BookView> {
    await assertPermission(ctx, 'bible.view');
    return toView(await runInWorkspaceContext(ctx, (db) => requireBook(db, ctx, bookId)));
}

export async function createBook(ctx: WorkspaceRequestContext, input: unknown): Promise<BookView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = BookCreateInput.parse(input);
    const data = bookWrite(parsed) as BookWrite & { title: string };
    return runInWorkspaceContext(ctx, async (db) => {
        const book = await BookRepository.create(db, ctx.workspaceId, data);
        await logEvent(ctx, { action: 'BOOK_CREATED', entityType: 'Book', entityId: book.id, details: { stage: book.stage } }, { db });
        return toView(book);
    });
}

export async function updateBook(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<BookView> {
    await assertPermission(ctx, 'bible.edit');
    const data = bookWrite(BookUpdateInput.parse(input));
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await BookRepository.update(db, ctx.workspaceId, bookId, data);
        await logEvent(
            ctx,
            { action: 'BOOK_UPDATED', entityType: 'Book', entityId: bookId, details: { changed: Object.keys(data).sort() } },
            { db },
        );
        return toView(await requireBook(db, ctx, bookId));
    });
}

export interface DeletedBookView {
    id: string;
    title: string;
    deletedAt: string;
    /** After this the book can no longer be restored; the next daily purge deletes it. */
    restorableUntil: string;
}

/** Delete a book: hidden at once, restorable by the OWNER for 30 days, then purged (`books.delete`). */
export async function deleteBook(ctx: WorkspaceRequestContext, bookId: string): Promise<DeletedBookView> {
    await assertPermission(ctx, 'books.delete');
    return runInWorkspaceContext(ctx, async (db) => {
        const book = await requireBook(db, ctx, bookId);
        const contents = await BookRepository.contents(db, ctx.workspaceId, bookId);
        const at = new Date();
        if ((await BookRepository.softDelete(db, ctx.workspaceId, bookId, at)) === 0) throw new NotFoundError('Book not found.');
        const until = restorableUntil(at);
        await logEvent(
            ctx,
            { action: 'BOOK_DELETED', entityType: 'Book', entityId: bookId, details: { ...contents, restorableUntil: until.toISOString() } },
            { db },
        );
        return { id: bookId, title: book.title, deletedAt: at.toISOString(), restorableUntil: until.toISOString() };
    });
}

/** Deleted books listed at most (newest deletion first); the list reads one more and says when it is cut. */
export const DELETED_BOOK_LIST_MAX = 100;

/** The workspace's books deleted in the last 30 days, still restorable (`books.delete`). */
export async function listDeletedBooks(ctx: WorkspaceRequestContext): Promise<{ books: DeletedBookView[]; truncated: boolean }> {
    await assertPermission(ctx, 'books.delete');
    const rows = await runInWorkspaceContext(ctx, (db) => BookRepository.listDeleted(db, ctx.workspaceId, restoreCutoff(new Date()), DELETED_BOOK_LIST_MAX + 1));
    return {
        books: rows.slice(0, DELETED_BOOK_LIST_MAX).map((b) => ({
            id: b.id,
            title: b.title,
            deletedAt: b.deletedAt!.toISOString(),
            restorableUntil: restorableUntil(b.deletedAt!).toISOString(),
        })),
        truncated: rows.length > DELETED_BOOK_LIST_MAX,
    };
}

/** Bring back a book deleted in the last 30 days, whole (`books.delete`). Past the window, or never deleted, it is a 404. */
export async function restoreBook(ctx: WorkspaceRequestContext, bookId: string): Promise<BookView> {
    await assertPermission(ctx, 'books.delete');
    return runInWorkspaceContext(ctx, async (db) => {
        if ((await BookRepository.restore(db, ctx.workspaceId, bookId, restoreCutoff(new Date()))) === 0) throw new NotFoundError('Book not found.');
        const contents = await BookRepository.contents(db, ctx.workspaceId, bookId);
        await logEvent(ctx, { action: 'BOOK_RESTORED', entityType: 'Book', entityId: bookId, details: contents }, { db });
        return toView(await requireBook(db, ctx, bookId));
    });
}
