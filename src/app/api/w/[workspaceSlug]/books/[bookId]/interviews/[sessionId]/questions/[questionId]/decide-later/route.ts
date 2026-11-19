/**
 * POST …/interviews/:sessionId/questions/:questionId/decide-later — set a question of the open round
 * aside (`bible.edit`). Its field, and every field that depends on it, wait in this interview; a
 * later interview asks it again while it is still empty.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { decideLater } from '@/app-layer/usecases/interview-answers';

type Params = { workspaceSlug: string; bookId: string; sessionId: string; questionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) =>
        NextResponse.json({ question: await decideLater(ctx, params.bookId, params.sessionId, params.questionId) }, { status: 201 }),
    ),
);
