/**
 * POST …/manuscript/deleted-scenes/:sceneId/restore — bring back a scene deleted in the last 30 days, with its text,
 * note, card, links, history and research proposals, at its place or at the end of its chapter (`bible.edit`;
 * Phase 5.H-a, issue #71). Past the window, or never deleted, is a 404.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { restoreScene } from '@/app-layer/usecases/manuscript';

type Params = { workspaceSlug: string; bookId: string; sceneId: string };

export const POST = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await restoreScene(ctx, params.bookId, params.sceneId))));
