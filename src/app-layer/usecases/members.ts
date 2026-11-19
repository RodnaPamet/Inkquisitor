/**
 * Workspace members: list them, change a role, remove one.
 *
 * Every call runs inside `runInWorkspaceContext` (as app_user, under the
 * `workspace_isolation` policy) and asks its permission of the context first
 * (`assertPermission`, which audits a refusal). Changes are audited
 * (MEMBERSHIP_ROLE_CHANGED, MEMBERSHIP_REMOVED) in the same transaction as the
 * change, so the trail never records a change that rolled back.
 *
 * LAST-OWNER PROTECTION: a workspace always keeps at least one OWNER. The
 * count runs after a per-workspace advisory lock, so two owners demoting each
 * other at once cannot both succeed under READ COMMITTED (the loser waits,
 * then counts one owner and is refused).
 *
 * No invitation flow exists yet (memberships other than the sign-up OWNER
 * arrive with invites), but the rules live here so that flow inherits them.
 */
import type { WorkspaceRequestContext, WorkspaceRole } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';

export interface MemberView {
    membershipId: string;
    userId: string;
    name: string | null;
    email: string;
    role: WorkspaceRole;
    joinedAt: string;
}

export async function listMembers(ctx: WorkspaceRequestContext): Promise<MemberView[]> {
    await assertPermission(ctx, 'members.view');
    const rows = await runInWorkspaceContext(ctx, (db) => MembershipRepository.listForWorkspace(db, ctx.workspaceId));
    return rows.map((r) => ({
        membershipId: r.id,
        userId: r.user.id,
        name: r.user.name,
        email: r.user.email,
        role: r.role,
        joinedAt: r.createdAt.toISOString(),
    }));
}

async function lockOwners(db: PrismaTx, workspaceId: string): Promise<void> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'workspace-owner:' + workspaceId}))`;
}

const LAST_OWNER = { reason: 'LAST_OWNER' } as const;

export async function changeMemberRole(ctx: WorkspaceRequestContext, membershipId: string, role: WorkspaceRole): Promise<{ membershipId: string; role: WorkspaceRole }> {
    await assertPermission(ctx, 'members.manage');
    return runInWorkspaceContext(ctx, async (db) => {
        await lockOwners(db, ctx.workspaceId);
        const member = await MembershipRepository.find(db, ctx.workspaceId, membershipId);
        if (!member) throw new NotFoundError('Member not found.');
        if (member.role === role) return { membershipId, role };
        if (member.role === 'OWNER' && (await MembershipRepository.countOwners(db, ctx.workspaceId)) <= 1) {
            throw new ConflictError('A workspace must keep at least one owner.', LAST_OWNER);
        }
        await MembershipRepository.updateRole(db, ctx.workspaceId, membershipId, role);
        await logEvent(
            ctx,
            {
                action: 'MEMBERSHIP_ROLE_CHANGED',
                entityType: 'WorkspaceMembership',
                entityId: membershipId,
                details: { userId: member.userId, from: member.role, to: role },
            },
            { db },
        );
        return { membershipId, role };
    });
}

export async function removeMember(ctx: WorkspaceRequestContext, membershipId: string): Promise<{ membershipId: string }> {
    await assertPermission(ctx, 'members.manage');
    return runInWorkspaceContext(ctx, async (db) => {
        await lockOwners(db, ctx.workspaceId);
        const member = await MembershipRepository.find(db, ctx.workspaceId, membershipId);
        if (!member) throw new NotFoundError('Member not found.');
        if (member.role === 'OWNER' && (await MembershipRepository.countOwners(db, ctx.workspaceId)) <= 1) {
            throw new ConflictError('A workspace must keep at least one owner.', LAST_OWNER);
        }
        await MembershipRepository.remove(db, ctx.workspaceId, membershipId);
        await logEvent(
            ctx,
            {
                action: 'MEMBERSHIP_REMOVED',
                entityType: 'WorkspaceMembership',
                entityId: membershipId,
                details: { userId: member.userId, role: member.role },
            },
            { db },
        );
        return { membershipId };
    });
}
