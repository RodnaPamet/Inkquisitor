/**
 * What every source usecase shares (Phase 4.0): finding a source the caller
 * may reach, and which sources a book draws on.
 *
 * A BOOK library's source is reached only while its book is live (a deleted
 * book's sources answer 404, as everything under a deleted book does). The
 * series library's sources are reached by anyone in the workspace who may read
 * the bible. A book DRAWS ON its own library's sources and the series sources
 * it opted into (D26) — and on nothing else: no other book's library, no
 * series source it did not choose, nothing of another workspace (RLS).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import { BookSeriesSourceRepository, SourceLibraryRepository, SourceRepository, type SourceRow } from '@/app-layer/repositories/source.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { NotFoundError } from '@/lib/errors/types';
import { SOURCES_PER_LIBRARY_MAX } from '@/lib/sources/vocabulary';

/** A library row read at most: its cap, with room for the superseded versions a library may still hold. */
export const LIBRARY_READ_MAX = SOURCES_PER_LIBRARY_MAX + 1;

/** A source the caller may reach (the header), or 404. */
export async function requireSource(db: PrismaTx, ctx: WorkspaceRequestContext, sourceId: string): Promise<SourceRow> {
    const source = await SourceRepository.find(db, ctx.workspaceId, sourceId);
    if (!source) throw new NotFoundError('Source not found.');
    if (source.library.scope === 'BOOK') {
        const book = source.library.bookId ? await BookRepository.find(db, ctx.workspaceId, source.library.bookId) : null;
        if (!book) throw new NotFoundError('Source not found.');
    }
    return source;
}

export interface BookSourceSet {
    /** The book's own library's sources. */
    bookSourceIds: string[];
    /** The series sources the book opted into. */
    seriesSourceIds: string[];
}

/** The sources a book draws on (the header). The book must already be known live. */
export async function bookSourceSet(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<BookSourceSet> {
    const library = await SourceLibraryRepository.findForBook(db, ctx.workspaceId, bookId);
    const own = library ? await SourceRepository.listForLibrary(db, ctx.workspaceId, library.id, LIBRARY_READ_MAX) : [];
    const optedIds = await BookSeriesSourceRepository.listForBook(db, ctx.workspaceId, bookId, LIBRARY_READ_MAX);
    // An opt-in names a series source: re-read so a stale id never widens the set.
    const opted = await SourceRepository.listByIds(db, ctx.workspaceId, optedIds);
    return { bookSourceIds: own.map((s) => s.id), seriesSourceIds: opted.filter((s) => s.library.scope === 'SERIES').map((s) => s.id) };
}
