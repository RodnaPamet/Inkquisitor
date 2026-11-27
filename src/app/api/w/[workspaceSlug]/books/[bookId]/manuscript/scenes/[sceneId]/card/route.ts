/**
 * GET …/manuscript/scenes/:sceneId/card — the scene's card (goal, conflict, outcome, what changed) and its latest
 *     versions (Phase 5.3; `bible.view`).
 * PUT …/manuscript/scenes/:sceneId/card — the author's edit of the whole card against its version (`bible.edit`):
 *     `{ baseVersion, goal, conflict, outcome, change }`; one card version when something changed. 409 VERSION_CONFLICT.
 *     Never the scene's prose (D3).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getSceneCard, saveSceneCard } from '@/app-layer/usecases/scene-card';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ card: await getSceneCard(ctx, params.bookId, params.sceneId) })));

export const PUT = withApiErrorHandling(requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ card: await saveSceneCard(ctx, params.bookId, params.sceneId, await readJsonBody(req)) })));
