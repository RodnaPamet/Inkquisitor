/**
 * GET /api/w/:workspaceSlug/books/:bookId/interviews/:sessionId — the interview, its progress
 * ("not assessed" before any question) and its current round's questions with their answers
 * (`bible.view`).
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getInterview } from '@/app-layer/usecases/interviews';

type Params = { workspaceSlug: string; bookId: string; sessionId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('bible.view', async (_req, { params }, ctx) =>
        NextResponse.json({ interview: await getInterview(ctx, params.bookId, params.sessionId) }),
    ),
);
