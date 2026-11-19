/**
 * Workspace memberships. Workspace-scoped: inside `runInWorkspaceContext`
 * the `workspace_isolation` policy limits every query to the context's
 * workspace, and every query here ALSO filters by `workspaceId` (defence in
 * depth, and a clear empty result when the app is right). The two lookups
 * that run before a context exists (`findForGate`, `listForUser`) take the
 * plain client from `runWithoutRls`.
 */
import type { Prisma, WorkspaceRole } from '@prisma/client';

type Db = Prisma.TransactionClient;

export const MembershipRepository = {
    create(db: Db, data: { workspaceId: string; userId: string; role: WorkspaceRole }) {
        return db.workspaceMembership.create({ data, select: { id: true, role: true } });
    },

    /** The gate's lookup: the workspace by slug and the user's membership in it. */
    findForGate(db: Db, slug: string, userId: string) {
        return db.workspace.findUnique({
            where: { slug },
            select: {
                id: true,
                slug: true,
                name: true,
                memberships: { where: { userId }, select: { id: true, role: true }, take: 1 },
            },
        });
    },

    /** The user's workspaces, oldest membership first. */
    listForUser(db: Db, userId: string, take: number) {
        return db.workspaceMembership.findMany({
            where: { userId },
            orderBy: { createdAt: 'asc' },
            take,
            select: { role: true, workspace: { select: { id: true, slug: true } } },
        });
    },

    countForUser(db: Db, userId: string) {
        return db.workspaceMembership.count({ where: { userId } });
    },

    listForWorkspace(db: Db, workspaceId: string, take = 200) {
        return db.workspaceMembership.findMany({
            where: { workspaceId },
            orderBy: { createdAt: 'asc' },
            take,
            select: { id: true, role: true, createdAt: true, user: { select: { id: true, name: true, email: true } } },
        });
    },

    find(db: Db, workspaceId: string, membershipId: string) {
        return db.workspaceMembership.findFirst({
            where: { id: membershipId, workspaceId },
            select: { id: true, role: true, userId: true },
        });
    },

    /** `userId`'s own membership in the workspace (the actor's current role, re-read inside a transaction). */
    findForUser(db: Db, workspaceId: string, userId: string) {
        return db.workspaceMembership.findFirst({ where: { workspaceId, userId }, select: { id: true, role: true } });
    },

    countOwners(db: Db, workspaceId: string) {
        return db.workspaceMembership.count({ where: { workspaceId, role: 'OWNER' } });
    },

    updateRole(db: Db, workspaceId: string, membershipId: string, role: WorkspaceRole) {
        return db.workspaceMembership.updateMany({ where: { id: membershipId, workspaceId }, data: { role } });
    },

    remove(db: Db, workspaceId: string, membershipId: string) {
        return db.workspaceMembership.deleteMany({ where: { id: membershipId, workspaceId } });
    },
};
