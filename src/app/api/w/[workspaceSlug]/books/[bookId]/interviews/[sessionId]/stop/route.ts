/**
 * POST …/interviews/:sessionId/stop — the author stops the interview (`bible.edit`); every answer
 * given is kept. 409 INTERVIEW_ENDED for one that has already ended.
 */
import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { stopInterview } from '@/app-layer/usecases/interviews';

type Params = { workspaceSlug: string; bookId: string; sessionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('bible.edit', async (_req, { params }, ctx) =>
        NextResponse.json({ interview: await stopInterview(ctx, params.bookId, params.sessionId) }),
    ),
);
