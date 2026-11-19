/**
 * The operational session record: one `UserSession` row per sign-in, checked
 * on every JWT pass (Phase 0.3).
 *
 *   recordNewSession   at sign-in (the `jwt` callback's sign-in branch). Mints
 *                      a 128-bit `sessionId`, which the JWT carries as
 *                      `userSessionId`. THROWS when the row cannot be written:
 *                      a session that cannot be revoked is not handed out.
 *   verifySession      every later pass. One query reads the row and the
 *                      user's `sessionVersion`. A revoked, expired or missing
 *                      row, or a bumped version, makes the callback throw
 *                      `SessionRevokedError` (src/lib/auth/session-revoked.ts).
 *                      A database error is reported as `unavailable` and the
 *                      caller lets the request through: a blip must not sign
 *                      every browser out (NextAuth would clear the cookie).
 *   revoke…            sign-out, "sign out other sessions", one row.
 *
 * `UserSession` is not workspace-scoped (a person signs in once and may reach
 * several workspaces), so it is read on the plain client; app_user holds no
 * grant on it (see the Phase 0.3 migration).
 *
 * Lifted from inflect-compliance's `src/lib/security/session-tracker.ts`
 * (see docs/carve-manifest.md). Not carried: per-tenant session policy
 * (concurrency cap, max age) and the tenant column.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/observability/logger';

/** A session lives this long from sign-in; the JWT's `maxAge` matches it (src/auth.ts). */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** `lastActiveAt` is written at most this often. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function pickIp(headers: Headers | null): string | null {
    if (!headers) return null;
    const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const ip = forwarded || headers.get('x-real-ip')?.trim() || null;
    return ip ? ip.slice(0, 64) : null;
}

function pickUserAgent(headers: Headers | null): string | null {
    const ua = headers?.get('user-agent');
    return ua ? ua.slice(0, 512) : null;
}

async function readRequestHeaders(): Promise<Headers | null> {
    try {
        const mod = await import('next/headers');
        return (await mod.headers()) as unknown as Headers;
    } catch {
        // Outside a request (a test, a script): no headers to record.
        return null;
    }
}

export interface RecordedSession {
    sessionId: string;
    rowId: string;
}

export async function recordNewSession(input: { userId: string; headers?: Headers | null }): Promise<RecordedSession> {
    const sessionId = randomBytes(16).toString('hex');
    const headers = input.headers !== undefined ? input.headers : await readRequestHeaders();
    const row = await prisma.userSession.create({
        data: {
            sessionId,
            userId: input.userId,
            ipAddress: pickIp(headers),
            userAgent: pickUserAgent(headers),
            expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
        },
        select: { id: true },
    });
    return { sessionId, rowId: row.id };
}

export type SessionVerdict =
    | { status: 'active'; userId: string; sessionVersion: number }
    | { status: 'revoked' | 'expired' | 'missing' }
    | { status: 'unavailable' };

export async function verifySession(sessionId: string): Promise<SessionVerdict> {
    try {
        const row = await prisma.userSession.findUnique({
            where: { sessionId },
            select: {
                id: true,
                userId: true,
                revokedAt: true,
                expiresAt: true,
                lastActiveAt: true,
                user: { select: { sessionVersion: true } },
            },
        });
        if (!row) return { status: 'missing' };
        if (row.revokedAt) return { status: 'revoked' };
        const now = Date.now();
        if (row.expiresAt.getTime() <= now) {
            await prisma.userSession
                .updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date(now), revokedReason: 'expired' } })
                .catch(() => undefined);
            return { status: 'expired' };
        }
        if (now - row.lastActiveAt.getTime() >= TOUCH_INTERVAL_MS) {
            await prisma.userSession.update({ where: { id: row.id }, data: { lastActiveAt: new Date(now) } }).catch(() => undefined);
        }
        return { status: 'active', userId: row.userId, sessionVersion: row.user.sessionVersion };
    } catch (err) {
        logger.warn('session-tracker.verify_failed', {
            component: 'session-tracker',
            errorName: err instanceof Error ? err.name : 'unknown',
        });
        return { status: 'unavailable' };
    }
}

export type SessionRevocationCause = 'signout' | 'user' | 'other-sessions';

/** Revoke one session by its JWT id. True when a live row was revoked. */
export async function revokeSessionBySessionId(sessionId: string, reason: SessionRevocationCause): Promise<boolean> {
    const result = await prisma.userSession.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count > 0;
}

/** Revoke one of `userId`'s sessions by its row id; never another person's. */
export async function revokeUserSessionRow(userId: string, rowId: string, reason: SessionRevocationCause): Promise<boolean> {
    const result = await prisma.userSession.updateMany({
        where: { id: rowId, userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count > 0;
}

/** Revoke every live session of `userId` except `keepSessionId`. Returns how many. */
export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    const result = await prisma.userSession.updateMany({
        where: { userId, revokedAt: null, NOT: { sessionId: keepSessionId } },
        data: { revokedAt: new Date(), revokedReason: 'other-sessions' },
    });
    return result.count;
}

export interface ActiveSessionRow {
    id: string;
    sessionId: string;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
    lastActiveAt: Date;
    expiresAt: Date;
}

/** `userId`'s live sessions, most recently active first. */
export async function listActiveSessions(userId: string, limit = 50): Promise<ActiveSessionRow[]> {
    return prisma.userSession.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastActiveAt: 'desc' },
        take: limit,
        select: { id: true, sessionId: true, ipAddress: true, userAgent: true, createdAt: true, lastActiveAt: true, expiresAt: true },
    });
}
