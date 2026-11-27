/**
 * GET …/manuscript/deleted-scenes — the manuscript's Recently deleted: scenes deleted in the last 30 days, still
 * restorable, newest first (`bible.view`; Phase 5.H-a, issue #71).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listDeletedScenes } from '@/app-layer/usecases/manuscript';

type Params = { workspaceSlug: string; bookId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json(await listDeletedScenes(ctx, params.bookId))));
