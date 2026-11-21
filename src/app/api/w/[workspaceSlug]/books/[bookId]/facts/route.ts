/**
 * GET …/books/:bookId/facts?status=&sourceId=&after= — the facts the book draws on, each quoted with its
 * passage and provenance (Phase 4.0, D23, D26; `bible.view`), at most a page, with the offered ids and the
 * token a bulk confirm needs. `status` is PENDING (the default), CONFIRMED, REJECTED or ALL.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listBookFacts } from '@/app-layer/usecases/source-facts';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (req, { params }, ctx) => {
        const q = req.nextUrl.searchParams;
        return NextResponse.json(await listBookFacts(ctx, params.bookId, { status: q.get('status'), sourceId: q.get('sourceId'), after: q.get('after') }));
    }),
);
