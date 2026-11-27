/**
 * PUT …/manuscript/scenes/:sceneId/text — an autosave `{ html, baseRevision, checkpoint? }` (Phase 5.1, D33,
 * `bible.edit`): the text sanitised and stored, its links derived from its mentions, a version written at a checkpoint
 * or past the server's bound. 409 VERSION_CONFLICT with `currentRevision` when the scene moved on.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { saveSceneText } from '@/app-layer/usecases/manuscript-scenes';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const PUT = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await saveSceneText(ctx, params.bookId, params.sceneId, await readJsonBody(req)))),
);
