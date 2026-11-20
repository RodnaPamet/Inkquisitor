/**
 * POST …/books/:bookId/maps/:kind/snapshots/:version/restore — apply that snapshot as a NEW save
 * (`bible.edit`). Body: `{ "expectedVersion": n }`; a stale version is a 409 `VERSION_CONFLICT`.
 * Nodes and edges whose element or relation is gone are left out and counted in `dropped`.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { restoreMapSnapshot } from '@/app-layer/usecases/story-maps';

type Params = { workspaceSlug: string; bookId: string; kind: string; version: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json(await restoreMapSnapshot(ctx, params.bookId, params.kind, params.version, await readJsonBody(req)), { status: 201 }),
    ),
);
