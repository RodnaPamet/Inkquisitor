/**
 * GET  …/books/:bookId/draft-mismatches/:proposalId/update-bible — "Update the bible" (Phase 5.3, D35 item 3;
 *      `bible.edit`): the bible entry's field the mismatch is about, its current value, and the draft's value PREFILLED.
 *      Nothing is saved. 409 PROPOSAL_DECIDED, BIBLE_FACT_GONE, NO_FIELD_TO_UPDATE.
 * POST …/books/:bookId/draft-mismatches/:proposalId/update-bible — the author's own save of the value they edited
 *      (`bible.edit`): `{ baseVersion, value }`; one version of source MANUSCRIPT naming the scene, and the mismatch
 *      decided BIBLE_UPDATED in the same transaction. 409 VERSION_CONFLICT, PROPOSAL_DECIDED; 400 NOTHING_CHANGED,
 *      FIELD_VALUES_REFUSED.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getDraftUpdatePrefill, updateBibleFromDraft } from '@/app-layer/usecases/draft-mismatches';

type Params = { workspaceSlug: string; bookId: string; proposalId: string };

export const GET = withApiErrorHandling(requirePermission<Params>('bible.edit', async (_req, { params }, ctx) => NextResponse.json({ prefill: await getDraftUpdatePrefill(ctx, params.bookId, params.proposalId) })));

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) => NextResponse.json({ update: await updateBibleFromDraft(ctx, params.bookId, params.proposalId, await readJsonBody(req)) })),
);
