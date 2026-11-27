/** GET …/manuscript/scenes/:sceneId/versions/:versionNumber — one version's text (Phase 5.1, `bible.view`). */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getSceneVersion } from '@/app-layer/usecases/manuscript-scenes';

type Params = { workspaceSlug: string; bookId: string; sceneId: string; versionNumber: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ version: await getSceneVersion(ctx, params.bookId, params.sceneId, params.versionNumber) })),
);
