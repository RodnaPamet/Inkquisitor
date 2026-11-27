/**
 * What the manuscript pages read (Phase 5.1): the book and its outline; the book
 * and one scene. `bible.view` (every usecase asks it).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { getBook } from './books';
import { getManuscriptOutline } from './manuscript';
import { getScene } from './manuscript-scenes';

export async function loadManuscriptPage(ctx: WorkspaceRequestContext, bookId: string) {
    const [book, outline] = await Promise.all([getBook(ctx, bookId), getManuscriptOutline(ctx, bookId)]);
    return { book, outline };
}

export async function loadScenePage(ctx: WorkspaceRequestContext, bookId: string, sceneId: string) {
    const [book, scene] = await Promise.all([getBook(ctx, bookId), getScene(ctx, bookId, sceneId)]);
    return { book, scene };
}
