/**
 * POST …/interviews/:sessionId/questions/:questionId/skip — skip a question of the open round
 * (`bible.edit`). The field is not asked again in this interview.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { skipQuestion } from '@/app-layer/usecases/interview-answers';

type Params = { workspaceSlug: string; bookId: string; sessionId: string; questionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) =>
        NextResponse.json({ question: await skipQuestion(ctx, params.bookId, params.sessionId, params.questionId) }, { status: 201 }),
    ),
);
