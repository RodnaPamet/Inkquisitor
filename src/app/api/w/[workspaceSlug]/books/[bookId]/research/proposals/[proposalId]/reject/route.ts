/**
 * POST …/research/proposals/:proposalId/reject — reject a research proposal
 * (Phase 2.6, `bible.edit`). Nothing is written to the bible.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { rejectResearchProposal } from '@/app-layer/usecases/research-review';

type Params = { workspaceSlug: string; bookId: string; proposalId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json({ decision: await rejectResearchProposal(ctx, params.bookId, params.proposalId) })),
);
