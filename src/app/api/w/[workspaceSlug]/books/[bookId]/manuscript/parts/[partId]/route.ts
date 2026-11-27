/**
 * PATCH  …/manuscript/parts/:partId — rename `{ title }` (Phase 5.1, `bible.edit`).
 * DELETE …/manuscript/parts/:partId?confirmScenes=N — delete it; one still holding scenes is refused 409 NOT_EMPTY
 *        unless `confirmScenes` names that very count (`bible.edit`).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { confirmScenesParam } from '@/app-layer/schemas/manuscript';
import { deletePart, renamePart } from '@/app-layer/usecases/manuscript';

type Params = { workspaceSlug: string; bookId: string; partId: string };

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ outline: await renamePart(ctx, params.bookId, params.partId, await readJsonBody(req)) })),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json(await deletePart(ctx, params.bookId, params.partId, confirmScenesParam(req.nextUrl.searchParams.get('confirmScenes')))),
    ),
);
