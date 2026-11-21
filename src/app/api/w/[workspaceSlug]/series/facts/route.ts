/**
 * GET …/series/facts?status=&sourceId=&after= — the series library's facts (Phase 4.0, D26; `bible.view`),
 * as a book's facts page reads.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listSeriesFacts } from '@/app-layer/usecases/source-facts';

type Params = { workspaceSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (req, _route, ctx) => {
        const q = req.nextUrl.searchParams;
        return NextResponse.json(await listSeriesFacts(ctx, { status: q.get('status'), sourceId: q.get('sourceId'), after: q.get('after') }));
    }),
);
