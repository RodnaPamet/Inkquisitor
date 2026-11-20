/**
 * GET …/research/runs/:runId — one run's review: its findings with their quoted
 * sources, its proposals beside the current state of what each targets (Phase
 * 2.6, `bible.view`).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getResearchRunReview } from '@/app-layer/usecases/research-pages';

type Params = { workspaceSlug: string; bookId: string; runId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ review: await getResearchRunReview(ctx, params.bookId, params.runId) })),
);
