/**
 * GET    …/manuscript/scenes/:sceneId — the scene for the editor: text, details, linked elements with their summaries,
 *        beats, word counts, its neighbours (Phase 5.1, `bible.view`).
 * PATCH  …/manuscript/scenes/:sceneId — its details `{ baseRevision, title?, povElementId?, settingElementId?, storyTime?,
 *        linkedElementIds?, beatElementIds? }` (`bible.edit`; 409 VERSION_CONFLICT, 400 UNKNOWN_ELEMENT / WRONG_KIND).
 * DELETE …/manuscript/scenes/:sceneId — delete it; its history stays with the book (`bible.edit`).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { deleteScene } from '@/app-layer/usecases/manuscript';
import { getScene, updateSceneMeta } from '@/app-layer/usecases/manuscript-scenes';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ scene: await getScene(ctx, params.bookId, params.sceneId) })));

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ scene: await updateSceneMeta(ctx, params.bookId, params.sceneId, await readJsonBody(req)) })),
);

export const DELETE = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await deleteScene(ctx, params.bookId, params.sceneId))));
