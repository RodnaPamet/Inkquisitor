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
 * Deleting a book deletes everything in it: its elements, fields, relations
 * and their whole version history (the append-only trigger admits a version's
 * deletion only once its book is gone).
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

/** The sanitised write: each text value through the plain-text sanitiser, bounds checked after. */
function bookWrite(input: BookUpdateInput): BookWrite {
    return {
        ...(input.title !== undefined ? { title: requiredLine(input.title, BOOK_TITLE_MAX, 'Title') } : {}),
        ...(input.logline !== undefined ? { logline: optionalBlock(input.logline, BOOK_LOGLINE_MAX, 'Logline') } : {}),
        ...(input.genre !== undefined ? { genre: optionalLine(input.genre, BOOK_LABEL_MAX, 'Genre') } : {}),
        ...(input.audience !== undefined ? { audience: optionalLine(input.audience, BOOK_LABEL_MAX, 'Audience') } : {}),
        ...(input.targetLength !== undefined ? { targetLength: input.targetLength } : {}),
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
    };
}

export async function listBooks(ctx: WorkspaceRequestContext): Promise<BookView[]> {
    await assertPermission(ctx, 'bible.view');
    const rows = await runInWorkspaceContext(ctx, (db) => BookRepository.list(db, ctx.workspaceId));
    return rows.map(toView);
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

export async function deleteBook(ctx: WorkspaceRequestContext, bookId: string): Promise<{ id: string }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const contents = await BookRepository.contents(db, ctx.workspaceId, bookId);
        if ((await BookRepository.remove(db, ctx.workspaceId, bookId)) === 0) throw new NotFoundError('Book not found.');
        await logEvent(ctx, { action: 'BOOK_DELETED', entityType: 'Book', entityId: bookId, details: contents }, { db });
        return { id: bookId };
    });
}
