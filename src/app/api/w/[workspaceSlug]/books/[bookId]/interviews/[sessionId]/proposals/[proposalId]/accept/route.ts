/**
 * POST …/interviews/:sessionId/proposals/:proposalId/accept — accept a proposal, as proposed or
 * edited (Phase 2.5, `bible.edit`). Body: `{ baseVersion, reviewedCurrent?, value?, name?, summary?,
 * changeSummary? }` (`AcceptProposalInput`). Writes one version with source INTERVIEW naming the
 * cited answers. 409 VERSION_CONFLICT, PROPOSAL_OUTDATED, PROPOSAL_STALE, PROPOSAL_DECIDED,
 * ELEMENT_EXISTS; nothing written on a refusal.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { acceptProposal } from '@/app-layer/usecases/enrichment-review';

type Params = { workspaceSlug: string; bookId: string; sessionId: string; proposalId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ decision: await acceptProposal(ctx, params.bookId, params.sessionId, params.proposalId, await readJsonBody(req, { optional: true })) }),
    ),
);
