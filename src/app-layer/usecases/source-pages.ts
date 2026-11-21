/**
 * What the source pages read before their listings (Phase 4.0): the book's
 * title for the breadcrumbs, under `bible.view`. A missing or deleted book is
 * a 404 (`orNotFound`).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { requireBook } from './bible-common';

export async function requireBookForPage(ctx: WorkspaceRequestContext, bookId: string): Promise<{ id: string; title: string }> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        const book = await requireBook(db, ctx, bookId);
        return { id: book.id, title: book.title };
    });
}
