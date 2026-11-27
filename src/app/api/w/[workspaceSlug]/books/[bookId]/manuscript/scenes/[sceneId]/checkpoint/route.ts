/**
 * POST …/manuscript/scenes/:sceneId/checkpoint — `{ revision }`: version the stored text if the scene is at that
 * revision and it differs from the newest version (Phase 5.1, D33, `bible.edit`). Small, so a page leaving can send it
 * with `keepalive`.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { checkpointScene } from '@/app-layer/usecases/manuscript-scenes';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await checkpointScene(ctx, params.bookId, params.sceneId, await readJsonBody(req)))),
);
