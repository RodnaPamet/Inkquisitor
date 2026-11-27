/**
 * GET  …/manuscript/scenes/:sceneId/prose-checks — the scene's prose check for the editor's margin: status (NOT_CHECKED,
 *      PENDING, OUTDATED, CHECKED), readability, and the findings shown (rules off and dismissals left out, counted), each
 *      with the text it covered (Phase 5.2, D34, `bible.view`).
 * POST …/manuscript/scenes/:sceneId/prose-checks — check it now (`bible.edit`): `{ scheduled }` (SCHEDULED, UNAVAILABLE, OFF).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getSceneProseChecks, requestSceneProseCheck } from '@/app-layer/usecases/prose-checks';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await getSceneProseChecks(ctx, params.bookId, params.sceneId))));

export const POST = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await requestSceneProseCheck(ctx, params.bookId, params.sceneId))));
