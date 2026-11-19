/**
 * DELETE /api/account/sessions/:sessionId — sign out one of the signed-in
 * person's sessions (by row id). Self-service (`getUserCtx`); another
 * person's row id is a 404.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getUserCtx } from '@/app-layer/context';
import { revokeMySession } from '@/app-layer/usecases/sessions';

type RouteContext = { params: Promise<{ sessionId: string }> };

export const DELETE = withApiErrorHandling<RouteContext>(async (req: NextRequest, { params }) => {
    const ctx = await getUserCtx(req);
    const { sessionId } = await params;
    return NextResponse.json(await revokeMySession(ctx, sessionId));
});
