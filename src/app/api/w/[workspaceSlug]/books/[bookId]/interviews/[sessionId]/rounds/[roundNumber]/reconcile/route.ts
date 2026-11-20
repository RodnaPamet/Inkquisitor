/**
 * POST …/interviews/:sessionId/rounds/:roundNumber/reconcile — run a closed round's reconcile step
 * again (`bible.edit`; Phase 2.5): one that FAILED or was REFUSED. 409 RECONCILE_DONE for one that
 * has run, RECONCILE_RUNNING while one runs, ROUND_NOT_CLOSED for an open round; 503 AI_UNAVAILABLE
 * when no model call can be made (nothing written).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { reconcileRound } from '@/app-layer/usecases/enrichment-reconcile';

type Params = { workspaceSlug: string; bookId: string; sessionId: string; roundNumber: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) =>
        NextResponse.json({ reconcile: await reconcileRound(ctx, params.bookId, params.sessionId, params.roundNumber) }),
    ),
);
