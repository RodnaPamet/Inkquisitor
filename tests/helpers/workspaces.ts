/**
 * Integration-test fixtures for people and workspaces, built through the
 * product's own provisioning path (`provisionAccountWithWorkspace`), so a
 * fixture workspace has its data key, its OWNER and its audit rows exactly as
 * a sign-up would leave them. Emails are unique per call: suites share one
 * database and never clean the append-only audit trail.
 */
import { randomBytes } from 'node:crypto';
import type { WorkspaceRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { provisionAccountWithWorkspace, type ProvisionedAccount } from '@/app-layer/usecases/sign-up';
import { getPermissionsForRole } from '@/lib/permissions';
import type { WorkspaceRequestContext } from '@/app-layer/types';

export function uniqueEmail(label = 'author'): string {
    return `${label}-${randomBytes(6).toString('hex')}@example.test`;
}

export async function createAccount(
    options: { email?: string; name?: string; passwordHash?: string | null; workspaceName?: string } = {},
): Promise<ProvisionedAccount & { email: string }> {
    const email = options.email ?? uniqueEmail();
    const created = await provisionAccountWithWorkspace({
        email,
        name: options.name ?? 'Test Author',
        passwordHash: options.passwordHash ?? null,
        emailVerified: null,
        workspaceName: options.workspaceName ?? `Desk ${randomBytes(3).toString('hex')}`,
    });
    return { ...created, email };
}

/** A user with no workspace of their own (a future invitee). */
export async function createBareUser(email = uniqueEmail('member')): Promise<{ id: string; email: string }> {
    return prisma.user.create({ data: { email, name: 'Member' }, select: { id: true, email: true } });
}

/** Add `userId` to a workspace directly (no invitation flow exists yet). */
export async function addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<{ id: string }> {
    return prisma.workspaceMembership.create({ data: { workspaceId, userId, role }, select: { id: true } });
}

export function workspaceCtx(account: { userId: string; workspaceId: string; workspaceSlug: string }, role: WorkspaceRole = 'OWNER'): WorkspaceRequestContext {
    return {
        requestId: `test-${randomBytes(4).toString('hex')}`,
        userId: account.userId,
        workspaceId: account.workspaceId,
        workspaceSlug: account.workspaceSlug,
        role,
        permissions: getPermissionsForRole(role),
    };
}
