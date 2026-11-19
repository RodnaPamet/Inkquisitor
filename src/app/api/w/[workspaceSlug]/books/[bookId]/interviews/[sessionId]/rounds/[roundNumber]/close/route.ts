/**
 * POST …/interviews/:sessionId/rounds/:roundNumber/close — close the open round (`bible.edit`).
 * Body (optional): `{ "skipUnanswered"?: true }`; without it, an unanswered question refuses
 * 409 ROUND_HAS_UNANSWERED. The interview then ends if nothing is left to ask or its rounds are spent.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { closeRound } from '@/app-layer/usecases/interviews';

type Params = { workspaceSlug: string; bookId: string; sessionId: string; roundNumber: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({
            interview: await closeRound(ctx, params.bookId, params.sessionId, params.roundNumber, await readJsonBody(req, { optional: true })),
        }),
    ),
);
