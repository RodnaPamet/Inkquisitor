/**
 * POST …/books/:bookId/draft-mismatches/:proposalId/decision — decide a draft mismatch (Phase 5.3, D35; `bible.edit`).
 * Body: `{ decision: 'FIX_DRAFT' }` (the author will fix the draft; a later read that no longer finds the claim settles
 * it) or `{ decision: 'BOTH_TRUE', explanation }` (stored as a fact). "Update the bible" is its own route: the author's
 * save. 409 PROPOSAL_DECIDED; 400 EXPLANATION_REQUIRED.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { decideDraftMismatch } from '@/app-layer/usecases/draft-mismatches';

type Params = { workspaceSlug: string; bookId: string; proposalId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ mismatch: await decideDraftMismatch(ctx, params.bookId, params.proposalId, await readJsonBody(req)) })),
);
