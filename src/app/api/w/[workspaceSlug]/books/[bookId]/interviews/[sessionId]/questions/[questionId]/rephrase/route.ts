/**
 * POST …/interviews/:sessionId/questions/:questionId/rephrase — "Ask me this
 * differently" (Phase 2.4; `bible.edit`): an unanswered question of the open
 * round is replaced by a rephrase, which takes its place; the original can no
 * longer be answered. 201 `{ question }` (the rephrase, with
 * `replacesQuestionId`). 409 QUESTION_ANSWERED, QUESTION_SUPERSEDED,
 * REPHRASE_LIMIT, TOKEN_BUDGET, WORKSPACE_CEILING or NO_REPHRASE (nothing
 * acceptable to ask: the original stands); 503 AI_UNAVAILABLE.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { rephraseQuestion } from '@/app-layer/usecases/interview-rephrase';

type Params = { workspaceSlug: string; bookId: string; sessionId: string; questionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ question: await rephraseQuestion(ctx, params.bookId, params.sessionId, params.questionId, { signal: req.signal }) }, { status: 201 }),
    ),
);
