/**
 * GET …/manuscript/scenes/:sceneId/draft-notes — the scene held against the bible, for the editor's margin and side
 * panel (Phase 5.3, D35; `bible.view`): whether its current text was read (rule 6: never "no mismatches" for a scene
 * not read), its open draft mismatches (each placed only where its quote still stands) and its thread links.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getSceneDraftNotes } from '@/app-layer/usecases/draft-mismatches';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ notes: await getSceneDraftNotes(ctx, params.bookId, params.sceneId) })));
