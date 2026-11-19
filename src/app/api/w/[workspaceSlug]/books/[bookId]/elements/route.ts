/**
 * GET  /api/w/:workspaceSlug/books/:bookId/elements — one page of the book's elements by name, with
 *      `nextCursor` (`bible.view`). Query: `kind=CHARACTER` or `kinds=CHARACTER,FACTION`, `q=` (name
 *      contains), `after=` (the previous page's `nextCursor`), `take=` (1..200, default 100).
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
        const sp = req.nextUrl.searchParams;
        const query: Record<string, unknown> = {};
        for (const key of ['kind', 'q', 'after', 'take'] as const) {
            const v = sp.get(key);
            if (v !== null) query[key] = v;
        }
        const kinds = sp.get('kinds');
        if (kinds !== null) query.kinds = kinds.split(',');
        return NextResponse.json(await listElements(ctx, params.bookId, query));
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ element: await createElement(ctx, params.bookId, await readJsonBody(req)) }, { status: 201 }),
    ),
);
