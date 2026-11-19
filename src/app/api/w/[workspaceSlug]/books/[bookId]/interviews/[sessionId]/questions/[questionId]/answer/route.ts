/**
 * POST …/interviews/:sessionId/questions/:questionId/answer — answer a question of the open round
 * (`bible.edit`): `{ "text"?: "…", "choice"?: "…", "scale"?: 1..5, "acceptRecommendation"?: true }`,
 * as its kind takes. A re-answer is a new revision; once the round is closed, 409 ROUND_NOT_OPEN.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { requirePermission } from '@/lib/security/permission-middleware';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';

type Params = { workspaceSlug: string; bookId: string; sessionId: string; questionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (req, { params }, ctx) =>
        NextResponse.json({ question: await answerQuestion(ctx, params.bookId, params.sessionId, params.questionId, await readJsonBody(req)) }, { status: 201 }),
    ),
);
