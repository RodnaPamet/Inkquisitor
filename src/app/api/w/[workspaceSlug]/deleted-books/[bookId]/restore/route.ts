/**
 * POST /api/w/:workspaceSlug/deleted-books/:bookId/restore — bring back a book deleted
 * in the last 30 days, whole (`books.delete`, OWNER). Past the window, or a
 * book that is not deleted, is a 404.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { restoreBook } from '@/app-layer/usecases/books';

type Params = { workspaceSlug: string; bookId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('books.delete', async (_req, { params }, ctx) => NextResponse.json({ book: await restoreBook(ctx, params.bookId) })),
);
