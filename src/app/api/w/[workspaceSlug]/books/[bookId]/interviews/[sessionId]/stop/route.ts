/**
 * POST …/interviews/:sessionId/stop — the author stops the interview (`bible.edit`); every answer
 * given is kept. 409 INTERVIEW_ENDED for one that has already ended. The round the stop closes is
 * then reconciled (Phase 2.5): `reconcile` lists those runs, and a failed one never undoes the stop.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { stopInterviewAndReconcile } from '@/app-layer/usecases/enrichment-reconcile';

type Params = { workspaceSlug: string; bookId: string; sessionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await stopInterviewAndReconcile(ctx, params.bookId, params.sessionId))),
);
