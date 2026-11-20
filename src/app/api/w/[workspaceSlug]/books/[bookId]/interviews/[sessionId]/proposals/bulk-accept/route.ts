/**
 * POST …/interviews/:sessionId/proposals/bulk-accept — accept several ADD proposals into fields
 * still empty (Phase 2.5, `bible.edit`). Body: `{ items: [{ proposalId, baseVersion }] }`. One
 * ineligible item refuses them all, 409 BULK_INELIGIBLE naming it; nothing written.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { bulkAcceptProposals } from '@/app-layer/usecases/enrichment-review';

type Params = { workspaceSlug: string; bookId: string; sessionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ decisions: await bulkAcceptProposals(ctx, params.bookId, params.sessionId, await readJsonBody(req)) }),
    ),
);
