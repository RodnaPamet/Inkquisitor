/**
 * POST …/research/briefs/:briefId/runs — dispatch a run of the brief (Phase 2.6,
 * `bible.edit`): one QUEUED run and one background job naming it. 503
 * AI_UNAVAILABLE / RESEARCH_NOT_EVALUATED (D11), 409 RUN_IN_PROGRESS and 422
 * BRIEF_QUOTES_BIBLE before anything is written. 202 with the run's id; its
 * progress is `…/research/runs/:runId/stream`.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { dispatchResearchRun } from '@/app-layer/usecases/research-briefs';

type Params = { workspaceSlug: string; bookId: string; briefId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json(await dispatchResearchRun(ctx, params.bookId, params.briefId), { status: 202 })),
);
