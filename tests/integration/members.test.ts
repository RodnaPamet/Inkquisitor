/**
 * Membership changes and authorization denials, end to end: the route handler
 * (`requirePermission` → `getWorkspaceCtx`, which checks the membership in the
 * database), the usecase and its own policy check, the audit rows.
 *
 * The session is the one seam: `auth()` is stubbed to say who is signed in, so
 * no cookie or JWT is needed. Everything below it is real.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { PATCH, DELETE } from '@/app/api/w/[workspaceSlug]/members/[membershipId]/route';
import { GET as LIST } from '@/app/api/w/[workspaceSlug]/members/route';
import { changeMemberRole, removeMember } from '@/app-layer/usecases/members';
import { ForbiddenError } from '@/lib/errors/types';
import { verifyAuditChain } from '@/lib/audit/audit-writer';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let owner: Awaited<ReturnType<typeof createAccount>>;
let editor: { id: string };
let editorMembershipId: string;
let ownerMembershipId: string;

beforeAll(async () => {
    owner = await createAccount();
    editor = await createBareUser();
    editorMembershipId = (await addMember(owner.workspaceId, editor.id, 'EDITOR')).id;
    ownerMembershipId = (await prisma.workspaceMembership.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, userId: owner.userId } })).id;
});

function call(handler: typeof PATCH, method: string, membershipId: string, body?: unknown, slug = owner.workspaceSlug) {
    const req = new NextRequest(`http://localhost/api/w/${slug}/members/${membershipId}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return handler(req, { params: Promise.resolve({ workspaceSlug: slug, membershipId }) });
}

const deniedCount = () => prisma.auditLog.count({ where: { workspaceId: owner.workspaceId, action: 'AUTHZ_DENIED' } });

describe('requirePermission at the route', () => {
    it('no session → 401', async () => {
        session.userId = null;
        expect((await call(PATCH, 'PATCH', editorMembershipId, { role: 'READER' })).status).toBe(401);
    });

    it('a signed-in non-member → 404, the same answer as a workspace that does not exist', async () => {
        const stranger = await createAccount();
        session.userId = stranger.userId;
        const res = await call(PATCH, 'PATCH', editorMembershipId, { role: 'READER' });
        expect(res.status).toBe(404);
        const missing = await call(PATCH, 'PATCH', editorMembershipId, { role: 'READER' }, 'no-such-workspace-slug');
        expect(missing.status).toBe(404);
        expect((await res.json()).error.message).toBe((await missing.json()).error.message);
    });

    it('an EDITOR lacking members.manage → a generic 403, and an AUTHZ_DENIED row naming the key', async () => {
        session.userId = editor.id;
        const before = await deniedCount();
        const res = await call(PATCH, 'PATCH', ownerMembershipId, { role: 'READER' });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error.message).toBe('Permission denied');
        expect(JSON.stringify(body)).not.toContain('members.manage');
        expect(await deniedCount()).toBe(before + 1);
        const row = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, action: 'AUTHZ_DENIED' }, orderBy: { createdAt: 'desc' } });
        expect(row.actorUserId).toBe(editor.id);
        expect(row.detailsJson).toMatchObject({ permission: 'members.manage', role: 'EDITOR', method: 'PATCH' });
        // Nothing changed.
        expect((await prisma.workspaceMembership.findUniqueOrThrow({ where: { id: ownerMembershipId } })).role).toBe('OWNER');
    });

    it('an EDITOR may list members (members.view)', async () => {
        session.userId = editor.id;
        const req = new NextRequest(`http://localhost/api/w/${owner.workspaceSlug}/members`);
        const res = await LIST(req, { params: Promise.resolve({ workspaceSlug: owner.workspaceSlug }) });
        expect(res.status).toBe(200);
        const { members } = await res.json();
        expect(members.map((m: { role: string }) => m.role).sort()).toEqual(['EDITOR', 'OWNER']);
    });

    it('the OWNER changes a role → 200, recorded as MEMBERSHIP_ROLE_CHANGED', async () => {
        session.userId = owner.userId;
        const res = await call(PATCH, 'PATCH', editorMembershipId, { role: 'READER' });
        expect(res.status).toBe(200);
        expect((await prisma.workspaceMembership.findUniqueOrThrow({ where: { id: editorMembershipId } })).role).toBe('READER');
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { workspaceId: owner.workspaceId, action: 'MEMBERSHIP_ROLE_CHANGED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(row.detailsJson).toMatchObject({ userId: editor.id, from: 'EDITOR', to: 'READER' });
    });

    it('a body naming an unknown role → 400', async () => {
        session.userId = owner.userId;
        expect((await call(PATCH, 'PATCH', editorMembershipId, { role: 'ADMIN' })).status).toBe(400);
    });
});

describe('the usecase holds its own rules', () => {
    it('refuses a caller without the key even when reached directly, and records it', async () => {
        const before = await deniedCount();
        await expect(changeMemberRole(workspaceCtx({ ...owner, userId: editor.id }, 'READER'), ownerMembershipId, 'READER')).rejects.toBeInstanceOf(
            ForbiddenError,
        );
        expect(await deniedCount()).toBe(before + 1);
    });

    it('never leaves a workspace without an OWNER (demote or remove the last one → 409)', async () => {
        const ctx = workspaceCtx(owner, 'OWNER');
        await expect(changeMemberRole(ctx, ownerMembershipId, 'EDITOR')).rejects.toMatchObject({ status: 409, details: { reason: 'LAST_OWNER' } });
        await expect(removeMember(ctx, ownerMembershipId)).rejects.toMatchObject({ status: 409 });
        expect((await prisma.workspaceMembership.findUniqueOrThrow({ where: { id: ownerMembershipId } })).role).toBe('OWNER');
    });

    it('two owners demoting each other at once: exactly one succeeds', async () => {
        const other = await createBareUser();
        const otherMembershipId = (await addMember(owner.workspaceId, other.id, 'OWNER')).id;
        const results = await Promise.allSettled([
            changeMemberRole(workspaceCtx(owner, 'OWNER'), otherMembershipId, 'EDITOR'),
            changeMemberRole(workspaceCtx({ ...owner, userId: other.id }, 'OWNER'), ownerMembershipId, 'EDITOR'),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await prisma.workspaceMembership.count({ where: { workspaceId: owner.workspaceId, role: 'OWNER' } })).toBe(1);
    });

    it('removal by the OWNER via the route is recorded, and the trail still verifies', async () => {
        const leaving = await createBareUser();
        const leavingId = (await addMember(owner.workspaceId, leaving.id, 'READER')).id;
        const currentOwner = await prisma.workspaceMembership.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, role: 'OWNER' } });
        session.userId = currentOwner.userId;
        expect((await call(DELETE, 'DELETE', leavingId)).status).toBe(200);
        expect(await prisma.workspaceMembership.findUnique({ where: { id: leavingId } })).toBeNull();
        expect(await prisma.auditLog.count({ where: { workspaceId: owner.workspaceId, action: 'MEMBERSHIP_REMOVED', entityId: leavingId } })).toBe(1);
        expect((await verifyAuditChain(owner.workspaceId)).valid).toBe(true);
    });
});

describe('authority is re-checked inside the transaction that acts on it', () => {
    /** Three owners in a fresh workspace: A (the account), B and C. */
    async function threeOwners() {
        const acc = await createAccount();
        const b = await createBareUser();
        const c = await createBareUser();
        const aId = (await prisma.workspaceMembership.findFirstOrThrow({ where: { workspaceId: acc.workspaceId, userId: acc.userId } })).id;
        const bId = (await addMember(acc.workspaceId, b.id, 'OWNER')).id;
        const cId = (await addMember(acc.workspaceId, c.id, 'OWNER')).id;
        return { acc, a: { userId: acc.userId, membershipId: aId }, b: { userId: b.id, membershipId: bId }, c: { userId: c.id, membershipId: cId } };
    }

    const roleOf = async (id: string) => (await prisma.workspaceMembership.findUnique({ where: { id } }))?.role ?? null;
    const lastDenial = (workspaceId: string) =>
        prisma.auditLog.findFirstOrThrow({ where: { workspaceId, action: 'AUTHZ_DENIED' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const deniedIn = (workspaceId: string) => prisma.auditLog.count({ where: { workspaceId, action: 'AUTHZ_DENIED' } });

    /** Ungranted advisory-lock requests: how many transactions are queued on the owner lock. */
    const waiters = async () =>
        (await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0].n;
    const heldAdvisoryLocks = async () =>
        (await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`)[0].n;
    async function until(predicate: () => Promise<boolean>): Promise<void> {
        for (let i = 0; i < 200; i++) {
            if (await predicate()) return;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('timed out waiting for the lock queue');
    }

    it('three owners: A demotes B while B demotes C — B, demoted first, is refused, and C stays an OWNER', async () => {
        const { acc, a, b, c } = await threeOwners();
        // Both requests have passed their gate (their contexts say OWNER)
        // before either reaches the database. The lock is held so the order
        // in which they reach it is known: A first, then B.
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const holder = prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'workspace-owner:' + acc.workspaceId}))`;
                await gate;
            },
            { timeout: 20_000 },
        );
        await until(async () => (await heldAdvisoryLocks()) >= 1);
        const before = await waiters();
        const aDemotesB = changeMemberRole(workspaceCtx({ ...acc, userId: a.userId }, 'OWNER'), b.membershipId, 'EDITOR');
        await until(async () => (await waiters()) === before + 1);
        const bDemotesC = changeMemberRole(workspaceCtx({ ...acc, userId: b.userId }, 'OWNER'), c.membershipId, 'EDITOR');
        await until(async () => (await waiters()) === before + 2);
        const deniedBefore = await deniedIn(acc.workspaceId);
        release();
        await holder;

        await expect(aDemotesB).resolves.toEqual({ membershipId: b.membershipId, role: 'EDITOR' });
        await expect(bDemotesC).rejects.toBeInstanceOf(ForbiddenError);
        await expect(bDemotesC).rejects.toThrow('Permission denied');
        expect(await roleOf(b.membershipId)).toBe('EDITOR');
        expect(await roleOf(c.membershipId)).toBe('OWNER');
        expect(await deniedIn(acc.workspaceId)).toBe(deniedBefore + 1);
        const row = await lastDenial(acc.workspaceId);
        expect(row.actorUserId).toBe(b.userId);
        expect(row.detailsJson).toMatchObject({ permission: 'members.manage', role: 'OWNER', currentRole: 'EDITOR' });
        expect((await verifyAuditChain(acc.workspaceId)).valid).toBe(true);
    });

    it('a member removed while their request is in flight is refused, and nothing changes', async () => {
        const { acc, a, b, c } = await threeOwners();
        const bInFlight = workspaceCtx({ ...acc, userId: b.userId }, 'OWNER');
        await removeMember(workspaceCtx({ ...acc, userId: a.userId }, 'OWNER'), b.membershipId);
        const deniedBefore = await deniedIn(acc.workspaceId);

        await expect(changeMemberRole(bInFlight, c.membershipId, 'READER')).rejects.toBeInstanceOf(ForbiddenError);
        await expect(removeMember(bInFlight, c.membershipId)).rejects.toBeInstanceOf(ForbiddenError);
        expect(await roleOf(c.membershipId)).toBe('OWNER');
        expect(await deniedIn(acc.workspaceId)).toBe(deniedBefore + 2);
        const row = await lastDenial(acc.workspaceId);
        expect(row.actorUserId).toBe(b.userId);
        expect(row.detailsJson).toMatchObject({ permission: 'members.manage', currentRole: null });
    });
});
