/**
 * POST …/books/:bookId/thread-proposals/:proposalId/decision — accept or reject a proposed thread or pay-off
 * (Phase 4.2, D28; `bible.edit`). Body: `{ decision: 'ACCEPT' | 'REJECT' }`. 409 PROPOSAL_DECIDED, THREAD_NOT_OPEN.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { decideThreadProposal } from '@/app-layer/usecases/continuity';

type Params = { workspaceSlug: string; bookId: string; proposalId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ proposal: await decideThreadProposal(ctx, params.bookId, params.proposalId, await readJsonBody(req)) })),
);
