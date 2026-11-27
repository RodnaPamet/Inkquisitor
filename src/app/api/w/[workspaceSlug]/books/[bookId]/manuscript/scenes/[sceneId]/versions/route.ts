/** GET …/manuscript/scenes/:sceneId/versions?before=N — a page of the scene's text versions, newest first (Phase 5.1, `bible.view`). */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listSceneVersions } from '@/app-layer/usecases/manuscript-scenes';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (req, { params }, ctx) => NextResponse.json(await listSceneVersions(ctx, params.bookId, params.sceneId, req.nextUrl.searchParams.get('before') ?? undefined))),
);
