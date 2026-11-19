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
 * AUTHORITY IS RE-CHECKED UNDER THE LOCK. The context's role was read when
 * the request was gated, before the lock; by the time a change runs the
 * actor may have been demoted or removed by a change that committed first.
 * So inside the locked transaction the actor's own membership is read again
 * and the permission asked of THAT role; if it no longer holds, the
 * transaction does nothing, an AUTHZ_DENIED row (with `currentRole`) is
 * written on its own, and the answer is the same generic 403.
 *
 * No invitation flow exists yet (memberships other than the sign-up OWNER
 * arrive with invites), but the rules live here so that flow inherits them.
 */
import type { WorkspaceRequestContext, WorkspaceRole } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission, denyPermission } from '@/app-layer/policies/permission.policy';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import { getPermissionsForRole, hasPermission, type PermissionKey } from '@/lib/permissions';

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

/** The actor's authority, re-read inside the transaction, no longer holds. Never leaves this module. */
class AuthorityLapsed extends Error {
    constructor(readonly currentRole: WorkspaceRole | null) {
        super('authority lapsed');
        this.name = 'AuthorityLapsed';
    }
}

/**
 * Run `fn` in a workspace transaction that holds the owner lock and has
 * re-checked `key` against the actor's CURRENT membership. A lapse rolls the
 * transaction back, then is recorded and refused like any denial.
 */
async function withLiveAuthority<T>(ctx: WorkspaceRequestContext, key: PermissionKey, fn: (db: PrismaTx) => Promise<T>): Promise<T> {
    try {
        return await runInWorkspaceContext(ctx, async (db) => {
            await lockOwners(db, ctx.workspaceId);
            const own = await MembershipRepository.findForUser(db, ctx.workspaceId, ctx.userId);
            if (!own || !hasPermission(getPermissionsForRole(own.role), key)) throw new AuthorityLapsed(own?.role ?? null);
            return fn(db);
        });
    } catch (err) {
        if (err instanceof AuthorityLapsed) return denyPermission(ctx, key, {}, { currentRole: err.currentRole });
        throw err;
    }
}

export async function changeMemberRole(ctx: WorkspaceRequestContext, membershipId: string, role: WorkspaceRole): Promise<{ membershipId: string; role: WorkspaceRole }> {
    await assertPermission(ctx, 'members.manage');
    return withLiveAuthority(ctx, 'members.manage', async (db) => {
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
    return withLiveAuthority(ctx, 'members.manage', async (db) => {
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
