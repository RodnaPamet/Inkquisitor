/**
 * POST …/books/:bookId/fact-proposals/:proposalId/decision — decide a proposal (Phase 4.1, D27; `bible.edit`).
 * Body: `{ decision: 'INVALIDATE' | 'KEEP_BOTH' | 'REJECT' }`. 409 PROPOSAL_DECIDED for one already decided.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { decideFactProposal } from '@/app-layer/usecases/fact-proposals';

type Params = { workspaceSlug: string; bookId: string; proposalId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ proposal: await decideFactProposal(ctx, params.bookId, params.proposalId, await readJsonBody(req)) }),
    ),
);
