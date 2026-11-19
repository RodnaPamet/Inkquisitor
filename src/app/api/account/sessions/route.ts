/**
 * GET /api/account/sessions — the signed-in person's live sessions, the
 * current one marked. Self-service: `getUserCtx` requires a session and the
 * usecase reads only that person's rows.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { currentSessionId } from '@/lib/auth/current-session';
import { getUserCtx } from '@/app-layer/context';
import { listMySessions } from '@/app-layer/usecases/sessions';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    return NextResponse.json({ sessions: await listMySessions(ctx, await currentSessionId(req)) });
});
