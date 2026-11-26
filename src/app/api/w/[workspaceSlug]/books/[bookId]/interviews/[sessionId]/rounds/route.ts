/**
 * POST /api/w/:workspaceSlug/books/:bookId/interviews/:sessionId/rounds — generate the next round
 * (`bible.edit`); a paused interview resumes. The interview may instead end here, saying why
 * (FRONTIER_EMPTY, NOTHING_AT_DEPTH, ROUND_BUDGET), or pause (KILL_SWITCH, WORKSPACE_CEILING, a
 * model failure). 503 AI_UNAVAILABLE when no model call can be made (nothing is written);
 * 409 ROUND_OPEN while a round is open. Phase 4.4 (D30): an optional body `{ "goOn": true }` is the author's
 * choice to go on past the minor questions (an interview paused VALUE_FELL); QUESTION_BUDGET and SESSION_LIMIT
 * end it, VALUE_FELL pauses it.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { nextRound } from '@/app-layer/usecases/interviews';
import { readJsonBody } from '@/lib/http/json-body';

type Params = { workspaceSlug: string; bookId: string; sessionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ interview: await nextRound(ctx, params.bookId, params.sessionId, {}, await readJsonBody(req, { optional: true })) }, { status: 201 }),
    ),
);
