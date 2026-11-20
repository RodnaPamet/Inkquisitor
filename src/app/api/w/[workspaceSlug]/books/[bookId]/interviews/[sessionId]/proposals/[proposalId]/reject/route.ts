/**
 * POST …/interviews/:sessionId/proposals/:proposalId/reject — reject a proposal (Phase 2.5,
 * `bible.edit`): nothing is written to the bible. 409 PROPOSAL_DECIDED for one already decided.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { rejectProposal } from '@/app-layer/usecases/enrichment-review';

type Params = { workspaceSlug: string; bookId: string; sessionId: string; proposalId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) =>
        NextResponse.json({ decision: await rejectProposal(ctx, params.bookId, params.sessionId, params.proposalId) }),
    ),
);
