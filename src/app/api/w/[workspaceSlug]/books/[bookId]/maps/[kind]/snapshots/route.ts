/**
 * GET …/books/:bookId/maps/:kind/snapshots — the map's snapshots, one per save, newest first,
 * without their contents (`bible.view`); `truncated` when the list was cut.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listMapSnapshots } from '@/app-layer/usecases/story-maps';

type Params = { workspaceSlug: string; bookId: string; kind: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) =>
        NextResponse.json(await listMapSnapshots(ctx, params.bookId, params.kind)),
    ),
);
