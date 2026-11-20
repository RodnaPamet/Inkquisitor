/**
 * GET …/interviews/:sessionId/proposals — the interview's proposed bible changes (Phase 2.5,
 * `bible.view`): each field proposal with the field's current value and version, each proposed new
 * element, the answers each cites, and each round's reconcile run.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getSessionReview } from '@/app-layer/usecases/enrichment-review';

type Params = { workspaceSlug: string; bookId: string; sessionId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) => NextResponse.json({ review: await getSessionReview(ctx, params.bookId, params.sessionId) })),
);
