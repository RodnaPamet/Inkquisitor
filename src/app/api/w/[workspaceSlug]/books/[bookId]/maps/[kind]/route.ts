/**
 * GET …/books/:bookId/maps/:kind — the book's map of that kind (`relationship`, `plot`, `timeline`),
 * its nodes, edges and freeform layer, at version 0 when nobody has saved it (`bible.view`).
 * PUT — save the map's whole state (`bible.edit`). Body: `{ expectedVersion, nodes, edges, freeform }`;
 * a version other than the map's is a 409 `VERSION_CONFLICT` naming `currentVersion`, and nothing is written.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getStoryMap, saveStoryMap } from '@/app-layer/usecases/story-maps';

type Params = { workspaceSlug: string; bookId: string; kind: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) =>
        NextResponse.json({ map: await getStoryMap(ctx, params.bookId, params.kind) }),
    ),
);

export const PUT = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json(await saveStoryMap(ctx, params.bookId, params.kind, await readJsonBody(req))),
    ),
);
