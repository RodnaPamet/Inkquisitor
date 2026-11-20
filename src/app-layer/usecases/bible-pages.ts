/**
 * What each bible page reads (Phase 1.H): one function per page, called by
 * the page's server component and by the load test
 * (`tests/integration/bible-load.test.ts`), so the test measures exactly the
 * reads the page makes. Each composes the usecases (every one asks its own
 * permission); none reads anything a page does not show.
 *
 *   loadBooksPage     the live books (at most BOOK_LIST_MAX, cut lists say so)
 *   loadBookPage      the book and its board: per-kind counts and filled
 *                     fields by aggregate, the first entries of each kind
 *   loadElementPage   the book, the element (fields, relations), the first
 *                     page of versions, and (Phase 3.2) the story maps that
 *                     draw its kind, for their read-only views. The relation
 *                     picker searches the book itself (`listElements` with
 *                     `q`), so the page no longer reads every element of the
 *                     book.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { mapKindSlug, mapsDrawingKind, type StoryMapKindValue } from '@/lib/canvas/map-kinds';
import { getBookBoard, getElement } from './bible-elements';
import { getStoryMap, type StoryMapView } from './story-maps';
import { listVersions } from './bible-versions';
import { getBook, listBooks } from './books';

/** Versions read per page of the History tab. */
export const VERSION_PAGE_SIZE = 50;

export function loadBooksPage(ctx: WorkspaceRequestContext) {
    return listBooks(ctx);
}

export async function loadBookPage(ctx: WorkspaceRequestContext, bookId: string) {
    const [book, board] = await Promise.all([getBook(ctx, bookId), getBookBoard(ctx, bookId)]);
    return { book, board };
}

export async function loadElementPage(ctx: WorkspaceRequestContext, bookId: string, elementId: string) {
    const [book, element, versions] = await Promise.all([
        getBook(ctx, bookId),
        getElement(ctx, bookId, elementId),
        listVersions(ctx, bookId, elementId, { take: VERSION_PAGE_SIZE }),
    ]);
    // The maps that draw this kind (a character: the relationship map; a beat: the plot board; an event: the timeline).
    const maps: Array<{ kind: StoryMapKindValue; map: StoryMapView }> = await Promise.all(
        mapsDrawingKind(element.kind).map(async (kind) => ({ kind, map: await getStoryMap(ctx, bookId, mapKindSlug(kind)) })),
    );
    return { book, element, versions, maps };
}
