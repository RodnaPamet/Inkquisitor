/**
 * GET  /api/w/:workspaceSlug/books — the workspace's live books, most recently updated first, and whether the list is cut (`bible.view`)
 * POST /api/w/:workspaceSlug/books — create a book (`bible.edit`)
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { createBook, listBooks } from '@/app-layer/usecases/books';

export const GET = withApiErrorHandling(
    requirePermission('bible.view', async (_req, _args, ctx) => NextResponse.json(await listBooks(ctx))),
);

export const POST = withApiErrorHandling(
    requirePermission('bible.edit', async (req, _args, ctx) => NextResponse.json({ book: await createBook(ctx, await readJsonBody(req)) }, { status: 201 })),
);
