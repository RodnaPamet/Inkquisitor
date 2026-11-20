/**
 * POST …/interviews/:sessionId/rounds/:roundNumber/close — close the open round (`bible.edit`).
 * Body (optional): `{ "skipUnanswered"?: true }`; without it, an unanswered question refuses
 * 409 ROUND_HAS_UNANSWERED. The interview then ends if nothing is left to ask or its rounds are spent.
 * The closed round is then reconciled into proposed bible changes (Phase 2.5): `reconcile` is its
 * run (or null), and whatever becomes of it, the close stands.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { closeRoundAndReconcile } from '@/app-layer/usecases/enrichment-reconcile';

type Params = { workspaceSlug: string; bookId: string; sessionId: string; roundNumber: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json(await closeRoundAndReconcile(ctx, params.bookId, params.sessionId, params.roundNumber, await readJsonBody(req, { optional: true }))),
    ),
);
