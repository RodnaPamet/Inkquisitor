/**
 * Session hardening, through the real `jwt` callback and a real database.
 *
 * A sign-in records a `UserSession` row and puts its id on the token. Every
 * later pass verifies that row: a revoked, expired or missing row, or a bumped
 * `sessionVersion`, makes the callback THROW `SessionRevokedError` — which is
 * what makes `getServerSession` return null. Sign-out revokes the row.
 */
import type { JWT } from 'next-auth/jwt';
import type { Account, User } from 'next-auth';
import { prisma } from '@/lib/db';
import { authOptions } from '@/auth';
import { SessionRevokedError } from '@/lib/auth/session-revoked';
import { revokeSessionBySessionId } from '@/lib/security/session-tracker';
import { listMySessions, revokeMyOtherSessions, revokeMySession } from '@/app-layer/usecases/sessions';
import { createAccount } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

type JwtCallback = (params: { token: JWT; user?: User; account?: Account | null; trigger?: 'signIn' | 'signUp' | 'update' }) => Promise<JWT>;
const jwt = authOptions.callbacks!.jwt as unknown as JwtCallback;

let account: Awaited<ReturnType<typeof createAccount>>;
beforeAll(async () => {
    account = await createAccount({ name: 'Session Tester' });
});

async function signIn(): Promise<JWT> {
    return jwt({
        token: { email: account.email, name: 'Session Tester', sub: account.userId },
        user: { id: account.userId, email: account.email, name: 'Session Tester' },
        account: { provider: 'credentials', type: 'credentials', providerAccountId: account.userId },
        trigger: 'signIn',
    });
}

const pass = (token: JWT) => jwt({ token: { ...token } });

it('a sign-in records a session row and carries its id, the user and the membership claims', async () => {
    const token = await signIn();
    expect(token.userId).toBe(account.userId);
    expect(token.userSessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(token.memberships).toEqual([{ slug: account.workspaceSlug, workspaceId: account.workspaceId, role: 'OWNER' }]);
    expect(token.membershipsTruncated).toBe(false);
    const row = await prisma.userSession.findUniqueOrThrow({ where: { sessionId: token.userSessionId! } });
    expect(row.userId).toBe(account.userId);
    expect(row.revokedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    const audit = await prisma.auditLog.findFirst({ where: { workspaceId: account.workspaceId, action: 'USER_SIGNED_IN' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.detailsJson).toMatchObject({ method: 'credentials', sessionRowId: row.id });
});

it('a live session passes', async () => {
    const token = await signIn();
    await expect(pass(token)).resolves.toMatchObject({ userId: account.userId });
});

it('a revoked session THROWS', async () => {
    const token = await signIn();
    await revokeSessionBySessionId(token.userSessionId!, 'user');
    await expect(pass(token)).rejects.toBeInstanceOf(SessionRevokedError);
    await expect(pass(token)).rejects.toMatchObject({ reason: 'session_revoked' });
});

it('an expired session THROWS', async () => {
    const token = await signIn();
    await prisma.userSession.update({ where: { sessionId: token.userSessionId! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(pass(token)).rejects.toMatchObject({ reason: 'session_revoked' });
});

it('a token whose row does not exist, or that names no row, THROWS', async () => {
    const token = await signIn();
    await expect(pass({ ...token, userSessionId: 'f'.repeat(32) })).rejects.toMatchObject({ reason: 'session_missing' });
    await expect(pass({ ...token, userSessionId: undefined })).rejects.toMatchObject({ reason: 'session_missing' });
});

it('a token naming another person’s row THROWS', async () => {
    const other = await createAccount();
    const token = await signIn();
    await expect(pass({ ...token, userId: other.userId })).rejects.toMatchObject({ reason: 'session_missing' });
});

it('bumping sessionVersion signs every older token out', async () => {
    const token = await signIn();
    await prisma.user.update({ where: { id: account.userId }, data: { sessionVersion: { increment: 1 } } });
    await expect(pass(token)).rejects.toMatchObject({ reason: 'session_version_bumped' });
    // A token minted after the bump is fine.
    await expect(pass(await signIn())).resolves.toBeTruthy();
});

it('sign-out revokes the session row and records it', async () => {
    const token = await signIn();
    await authOptions.events!.signOut!({ token, session: undefined as never });
    const row = await prisma.userSession.findUniqueOrThrow({ where: { sessionId: token.userSessionId! } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe('signout');
    await expect(pass(token)).rejects.toBeInstanceOf(SessionRevokedError);
    expect(await prisma.auditLog.count({ where: { workspaceId: account.workspaceId, action: 'USER_SIGNED_OUT' } })).toBeGreaterThan(0);
});

describe("a person's own sessions", () => {
    it('lists them with this one marked, and signs out the others but keeps this one', async () => {
        const person = await createAccount();
        const signInAs = () =>
            jwt({
                token: { email: person.email },
                user: { id: person.userId, email: person.email },
                account: { provider: 'credentials', type: 'credentials', providerAccountId: person.userId },
            });
        const here = await signInAs();
        const elsewhere = await signInAs();
        const ctx = { requestId: 'sessions-test', userId: person.userId };

        const listed = await listMySessions(ctx, here.userSessionId!);
        expect(listed).toHaveLength(2);
        expect(listed.filter((s) => s.current)).toHaveLength(1);

        expect(await revokeMyOtherSessions(ctx, here.userSessionId!)).toEqual({ revoked: 1 });
        await expect(pass(here)).resolves.toBeTruthy();
        await expect(pass(elsewhere)).rejects.toBeInstanceOf(SessionRevokedError);
    });

    it('cannot revoke another person’s session', async () => {
        const mine = await createAccount();
        const theirs = await createAccount();
        const theirToken = await jwt({
            token: { email: theirs.email },
            user: { id: theirs.userId, email: theirs.email },
            account: { provider: 'credentials', type: 'credentials', providerAccountId: theirs.userId },
        });
        const theirRow = await prisma.userSession.findUniqueOrThrow({ where: { sessionId: theirToken.userSessionId! } });
        await expect(revokeMySession({ requestId: 'x', userId: mine.userId }, theirRow.id)).rejects.toMatchObject({ status: 404 });
        await expect(pass(theirToken)).resolves.toBeTruthy();
    });
});
