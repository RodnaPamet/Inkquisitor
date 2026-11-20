/**
 * POST …/research/proposals/:proposalId/accept — accept a research proposal, as
 * proposed or edited (Phase 2.6, `bible.edit`). Body: `{ baseVersion,
 * reviewedCurrent?, value?, name?, summary?, changeSummary? }`. Writes one
 * version with source RESEARCH naming the proposal and its findings. 409
 * VERSION_CONFLICT, PROPOSAL_OUTDATED, PROPOSAL_STALE, PROPOSAL_DECIDED,
 * ELEMENT_EXISTS; nothing written on a refusal.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { acceptResearchProposal } from '@/app-layer/usecases/research-review';

type Params = { workspaceSlug: string; bookId: string; proposalId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ decision: await acceptResearchProposal(ctx, params.bookId, params.proposalId, await readJsonBody(req, { optional: true })) }),
    ),
);
