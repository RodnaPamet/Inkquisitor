/** POST …/manuscript/scenes/:sceneId/versions/:versionNumber/restore — `{ baseRevision }`: the version's text as a new save and version (Phase 5.1, `bible.edit`). */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { restoreSceneVersion } from '@/app-layer/usecases/manuscript-scenes';

type Params = { workspaceSlug: string; bookId: string; sceneId: string; versionNumber: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json(await restoreSceneVersion(ctx, params.bookId, params.sceneId, params.versionNumber, await readJsonBody(req))),
    ),
);
