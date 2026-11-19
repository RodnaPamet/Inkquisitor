/**
 * Sign-up creates a person, their workspace (with its data key) and their
 * OWNER membership — and records it — in ONE transaction: all of it or none
 * of it. Also Google's way in, which shares the provisioning path.
 *
 * No test calls the breached-password service: `breachCheck` is a stub.
 */
import * as auditWriter from '@/lib/audit/audit-writer';
import { prisma } from '@/lib/db';
import { signUpWithPassword, resolveGoogleSignIn, provisionAccountWithWorkspace } from '@/app-layer/usecases/sign-up';
import { unwrapDek } from '@/lib/security/workspace-keys';
import { verifyPassword } from '@/lib/auth/passwords';
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/errors/types';
import { recordNewSession } from '@/lib/security/session-tracker';
import { createAccount, uniqueEmail } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const clean = async () => ({ breached: false as const });
const PASSWORD = ['correct', 'horse', 'battery', 'staple'].join('-');

async function everythingFor(email: string) {
    const user = await prisma.user.findUnique({ where: { email }, include: { memberships: { include: { workspace: true } } } });
    return user;
}

describe('signUpWithPassword', () => {
    it('creates the user, the workspace with a data key, the OWNER membership and three audit rows', async () => {
        const email = uniqueEmail('signup');
        const created = await signUpWithPassword(
            { email: `  ${email.toUpperCase()} `, password: PASSWORD, name: 'Ada Quill', workspaceName: 'Quill Works' },
            { breachCheck: clean },
        );

        const user = await everythingFor(email);
        expect(user).not.toBeNull();
        expect(user!.email).toBe(email); // normalised: trimmed, lower-cased
        expect(user!.passwordHash).not.toContain(PASSWORD);
        expect(await verifyPassword(PASSWORD, user!.passwordHash)).toBe(true);
        expect(user!.memberships).toHaveLength(1);
        const [membership] = user!.memberships;
        expect(membership.role).toBe('OWNER');
        expect(membership.workspace.id).toBe(created.workspaceId);
        expect(membership.workspace.slug).toBe(created.workspaceSlug);
        expect(created.workspaceSlug).toMatch(/^quill-works(-[0-9a-f]{6})?$/);

        // The data key is stored wrapped (a v1: envelope under the master KEK) and unwraps to 32 bytes.
        expect(membership.workspace.encryptedDek).toMatch(/^v1:/);
        expect(unwrapDek(membership.workspace.encryptedDek!)).toHaveLength(32);

        const audit = await prisma.auditLog.findMany({ where: { workspaceId: created.workspaceId }, orderBy: { createdAt: 'asc' } });
        expect(audit.map((r) => r.action)).toEqual(['USER_SIGNED_UP', 'WORKSPACE_CREATED', 'MEMBERSHIP_CREATED']);
        expect(audit.every((r) => r.actorUserId === user!.id)).toBe(true);
        // Ids and codes only: nothing the person typed.
        expect(JSON.stringify(audit.map((r) => r.detailsJson))).not.toMatch(/Ada|Quill|@/);
    });

    it('is atomic: a failure on the last write leaves no user, workspace or membership behind', async () => {
        const email = uniqueEmail('atomic');
        const spy = jest.spyOn(auditWriter, 'appendAuditEntryWithin');
        let calls = 0;
        spy.mockImplementation(async (...args) => {
            calls += 1;
            if (calls === 3) throw new Error('injected failure on the MEMBERSHIP_CREATED row');
            return jest.requireActual<typeof auditWriter>('@/lib/audit/audit-writer').appendAuditEntryWithin(...args);
        });
        const workspacesBefore = await prisma.workspace.count();
        try {
            await expect(signUpWithPassword({ email, password: PASSWORD, workspaceName: 'Never Was' }, { breachCheck: clean })).rejects.toThrow(
                /injected failure/,
            );
        } finally {
            spy.mockRestore();
        }
        expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
        expect(await prisma.workspace.count()).toBe(workspacesBefore);
        expect(await prisma.workspace.findFirst({ where: { name: 'Never Was' } })).toBeNull();
    });

    it('refuses a breached password, creating nothing', async () => {
        const email = uniqueEmail('breached');
        await expect(
            signUpWithPassword({ email, password: PASSWORD }, { breachCheck: async () => ({ breached: true, occurrences: 42 }) }),
        ).rejects.toMatchObject({ details: { reason: 'PASSWORD_BREACHED' } });
        expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });

    it('fails open when the breach service is unreachable', async () => {
        const email = uniqueEmail('outage');
        await signUpWithPassword({ email, password: PASSWORD }, { breachCheck: async () => ({ breached: false, skipped: true, reason: 'timeout' }) });
        expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
    });

    it('refuses a short password with a reason code', async () => {
        const err = await signUpWithPassword({ email: uniqueEmail(), password: 'short' }, { breachCheck: clean }).catch((e) => e);
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.details).toEqual({ reason: 'PASSWORD_TOO_SHORT' });
    });

    it('refuses an email that already has an account', async () => {
        const email = uniqueEmail('dup');
        await signUpWithPassword({ email, password: PASSWORD }, { breachCheck: clean });
        const err = await signUpWithPassword({ email: email.toUpperCase(), password: PASSWORD }, { breachCheck: clean }).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.details).toEqual({ reason: 'EMAIL_ALREADY_REGISTERED' });
        expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('gives a second workspace with the same name its own slug', async () => {
        const name = `Same Name ${Date.now()}`;
        const first = await createAccount({ workspaceName: name });
        const second = await createAccount({ workspaceName: name });
        expect(second.workspaceSlug).not.toBe(first.workspaceSlug);
        expect(second.workspaceSlug.startsWith(first.workspaceSlug.slice(0, 20))).toBe(true);
    });
});

describe('resolveGoogleSignIn', () => {
    const googleId = () => `g-${Math.random().toString(36).slice(2)}`;

    it('refuses an address Google did not verify', async () => {
        await expect(resolveGoogleSignIn({ providerAccountId: googleId(), email: uniqueEmail(), emailVerified: false })).rejects.toBeInstanceOf(
            ForbiddenError,
        );
        await expect(resolveGoogleSignIn({ providerAccountId: googleId(), email: uniqueEmail(), emailVerified: 'true' })).rejects.toBeInstanceOf(
            ForbiddenError,
        );
    });

    it('provisions a new person with a workspace and the Google link', async () => {
        const email = uniqueEmail('google');
        const id = googleId();
        const res = await resolveGoogleSignIn({ providerAccountId: id, email, emailVerified: true, name: 'Grace' });
        expect(res.outcome).toBe('created');
        const user = await everythingFor(email);
        expect(user!.passwordHash).toBeNull();
        expect(user!.emailVerified).not.toBeNull();
        expect(user!.memberships.map((m) => m.role)).toEqual(['OWNER']);
        expect(await prisma.account.findUnique({ where: { provider_providerAccountId: { provider: 'google', providerAccountId: id } } })).toMatchObject({
            userId: user!.id,
        });
        // The second sign-in resolves through the link.
        expect(await resolveGoogleSignIn({ providerAccountId: id, email, emailVerified: true })).toEqual({ userId: user!.id, outcome: 'existing' });
    });

    it('CLAIMS an account whose address nobody proved: the password goes and every session is signed out', async () => {
        const email = uniqueEmail('claim');
        await provisionAccountWithWorkspace({ email, name: null, passwordHash: 'not-a-real-hash', emailVerified: null, workspaceName: 'Claimed' });
        const before = await prisma.user.findUniqueOrThrow({ where: { email } });
        await recordNewSession({ userId: before.id, headers: null });

        const res = await resolveGoogleSignIn({ providerAccountId: googleId(), email, emailVerified: true });
        expect(res).toEqual({ userId: before.id, outcome: 'claimed' });
        const after = await prisma.user.findUniqueOrThrow({ where: { email } });
        expect(after.passwordHash).toBeNull();
        expect(after.emailVerified).not.toBeNull();
        expect(after.sessionVersion).toBe(before.sessionVersion + 1);
        expect(await prisma.userSession.count({ where: { userId: before.id, revokedAt: null } })).toBe(0);
    });

    it('LINKS an account whose address is already proved, keeping its password', async () => {
        const email = uniqueEmail('link');
        await provisionAccountWithWorkspace({ email, name: null, passwordHash: 'kept-hash', emailVerified: new Date(), workspaceName: 'Linked' });
        const res = await resolveGoogleSignIn({ providerAccountId: googleId(), email, emailVerified: true });
        expect(res.outcome).toBe('linked');
        expect((await prisma.user.findUniqueOrThrow({ where: { email } })).passwordHash).toBe('kept-hash');
    });
});
