/** GET …/books/:bookId/elements/:elementId/scenes — the manuscript scenes that dramatise a plot beat, in manuscript order (Phase 5.1, D33, `bible.view`). */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listBeatScenes } from '@/app-layer/usecases/manuscript-scenes';

type Params = { workspaceSlug: string; bookId: string; elementId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await listBeatScenes(ctx, params.bookId, params.elementId))));
