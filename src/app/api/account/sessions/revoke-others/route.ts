/**
 * POST /api/account/sessions/revoke-others — sign out every session of the
 * signed-in person except this one. Self-service (`getUserCtx`).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { currentSessionId } from '@/lib/auth/current-session';
import { getUserCtx } from '@/app-layer/context';
import { revokeMyOtherSessions } from '@/app-layer/usecases/sessions';

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    return NextResponse.json(await revokeMyOtherSessions(ctx, await currentSessionId(req)));
});
