/**
 * GET …/books/:bookId/maps/:kind/snapshots/:version — one snapshot's nodes, edges and freeform
 * layer, for the history's diff (`bible.view`).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getMapSnapshot } from '@/app-layer/usecases/story-maps';

type Params = { workspaceSlug: string; bookId: string; kind: string; version: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) =>
        NextResponse.json({ snapshot: await getMapSnapshot(ctx, params.bookId, params.kind, params.version) }),
    ),
);
