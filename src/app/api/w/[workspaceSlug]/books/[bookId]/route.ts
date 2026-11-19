/**
 * GET    /api/w/:workspaceSlug/books/:bookId — one book (`bible.view`)
 * PATCH  /api/w/:workspaceSlug/books/:bookId — change it (`bible.edit`)
 * DELETE /api/w/:workspaceSlug/books/:bookId — delete it and its whole bible (`bible.edit`)
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { deleteBook, getBook, updateBook } from '@/app-layer/usecases/books';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ book: await getBook(ctx, params.bookId) })),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ book: await updateBook(ctx, params.bookId, await readJsonBody(req)) }),
    ),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await deleteBook(ctx, params.bookId))),
);
