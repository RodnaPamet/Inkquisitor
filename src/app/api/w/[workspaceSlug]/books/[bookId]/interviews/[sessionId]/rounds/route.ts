/**
 * POST /api/w/:workspaceSlug/books/:bookId/interviews/:sessionId/rounds — generate the next round
 * (`bible.edit`); a paused interview resumes. The interview may instead end here, saying why
 * (FRONTIER_EMPTY, NOTHING_AT_DEPTH, ROUND_BUDGET). 503 MODEL_NOT_WIRED until the model layer is
 * wired (nothing is written); 409 ROUND_OPEN while a round is open.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { nextRound } from '@/app-layer/usecases/interviews';

type Params = { workspaceSlug: string; bookId: string; sessionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) =>
        NextResponse.json({ interview: await nextRound(ctx, params.bookId, params.sessionId) }, { status: 201 }),
    ),
);
