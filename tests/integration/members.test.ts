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
