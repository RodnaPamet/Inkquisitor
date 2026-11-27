/** PUT …/manuscript/scenes/:sceneId/note — the scene's note `{ note, baseNoteVersion }` (Phase 5.1, `bible.edit`; 409 VERSION_CONFLICT). */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { saveSceneNote } from '@/app-layer/usecases/manuscript-scenes';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const PUT = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json(await saveSceneNote(ctx, params.bookId, params.sceneId, await readJsonBody(req)))),
);
