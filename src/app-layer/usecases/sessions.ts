/**
 * A person's own sessions: list them, sign out one, sign out all the others.
 *
 * Self-service: the context is the signed-in person (`getUserCtx`) and every
 * query is bound to their user id, so nobody can see or revoke another
 * person's session. A revoked row makes that browser's next request fail the
 * `jwt` callback (`SessionRevokedError`), which signs it out. Each revocation
 * is audited (SESSION_REVOKED) on the person's workspaces' trails.
 */
import type { UserRequestContext } from '@/app-layer/context';
import { recordUserAuthEvent } from '@/lib/audit/user-auth-events';
import { listActiveSessions, revokeOtherSessions, revokeUserSessionRow } from '@/lib/security/session-tracker';
import { NotFoundError, ValidationError } from '@/lib/errors/types';

export interface SessionView {
    id: string;
    current: boolean;
    userAgent: string | null;
    ipAddress: string | null;
    createdAt: string;
    lastActiveAt: string;
}

export async function listMySessions(ctx: UserRequestContext, currentSessionId: string | null): Promise<SessionView[]> {
    const rows = await listActiveSessions(ctx.userId);
    return rows.map((r) => ({
        id: r.id,
        current: r.sessionId === currentSessionId,
        userAgent: r.userAgent,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt.toISOString(),
        lastActiveAt: r.lastActiveAt.toISOString(),
    }));
}

export async function revokeMyOtherSessions(ctx: UserRequestContext, currentSessionId: string | null): Promise<{ revoked: number }> {
    // Without knowing which session is this one, "the others" would include it.
    if (!currentSessionId) throw new ValidationError('The current session could not be identified.');
    const revoked = await revokeOtherSessions(ctx.userId, currentSessionId);
    if (revoked > 0) {
        await recordUserAuthEvent({ userId: ctx.userId, action: 'SESSION_REVOKED', details: { scope: 'others', count: revoked }, requestId: ctx.requestId });
    }
    return { revoked };
}

export async function revokeMySession(ctx: UserRequestContext, sessionRowId: string): Promise<{ revoked: true }> {
    const revoked = await revokeUserSessionRow(ctx.userId, sessionRowId, 'user');
    if (!revoked) throw new NotFoundError('Session not found.');
    await recordUserAuthEvent({ userId: ctx.userId, action: 'SESSION_REVOKED', details: { scope: 'one', sessionRowId }, requestId: ctx.requestId });
    return { revoked: true };
}
