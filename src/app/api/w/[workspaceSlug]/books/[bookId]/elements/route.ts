/**
 * GET  /api/w/:workspaceSlug/books/:bookId/elements[?kind=CHARACTER] — the book's elements (`bible.view`)
 * POST /api/w/:workspaceSlug/books/:bookId/elements — create one, with its first fields; writes version 1 (`bible.edit`)
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { createElement, listElements } from '@/app-layer/usecases/bible-elements';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (req, { params }, ctx) => {
        const kind = req.nextUrl.searchParams.get('kind');
        return NextResponse.json({ elements: await listElements(ctx, params.bookId, kind ? { kind } : {}) });
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ element: await createElement(ctx, params.bookId, await readJsonBody(req)) }, { status: 201 }),
    ),
);
