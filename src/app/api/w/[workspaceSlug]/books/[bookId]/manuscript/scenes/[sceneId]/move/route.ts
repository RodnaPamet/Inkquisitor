/** POST …/manuscript/scenes/:sceneId/move — `{ chapterId, after?, before? }` (Phase 5.1, `bible.edit`; 409 ORDER_STALE). */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { moveScene } from '@/app-layer/usecases/manuscript';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ outline: await moveScene(ctx, params.bookId, params.sceneId, await readJsonBody(req)) })),
);
