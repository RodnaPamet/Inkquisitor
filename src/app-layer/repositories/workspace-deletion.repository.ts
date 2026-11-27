/**
 * Whole-workspace deletion's queries (Phase 5.H-a, D36). No authorization here: `usecases/workspace-deletion.ts` asks
 * permission first. Three kinds of caller:
 *
 *   - inside the workspace's own context (`runInWorkspaceContext`, app_user, its row-level security): marking it
 *     deleted, restoring it, counting what it holds;
 *   - the discovery bypass (`workspace-deletion-discovery`, ids, names and dates only): the account's restorable
 *     workspaces, the purge's due list, the other memberships of an account;
 *   - the purge bypass (`workspace-purge`), as the owning role, in one transaction: lock, delete, the account.
 *
 * Every read is bounded. `deletedAt` is stamped by the database's clock for app_user (trigger
 * `workspace_deleted_at_is_now`), so the value this module writes is replaced.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = Prisma.TransactionClient | PrismaClient;

/** Restorable workspaces an account lists at most (an author has few; the bound is a safety net). */
export const RESTORABLE_WORKSPACES_MAX = 50;

export const WorkspaceDeletionRepository = {
    async dbNow(db: Db): Promise<Date> {
        const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
        return now;
    },

    /** The account's memberships in workspaces other than `workspaceId` that are not deleted (an account still in use elsewhere). */
    async countOtherMemberships(db: Db, userId: string, workspaceId: string): Promise<number> {
        return db.workspaceMembership.count({ where: { userId, workspaceId: { not: workspaceId }, workspace: { deletedAt: null } } });
    },

    /** Every membership the account still holds (the purge's last check before it deletes the account). */
    async countMemberships(db: Db, userId: string): Promise<number> {
        return db.workspaceMembership.count({ where: { userId } });
    },

    async findLive(db: Db, workspaceId: string) {
        return db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, name: true } });
    },

    /** Mark a live workspace deleted (inside its context); null when it was not live. */
    async markDeleted(db: Db, workspaceId: string, data: { deletedById: string; purgeAccountOfId: string | null }): Promise<{ deletedAt: Date } | null> {
        const r = await db.workspace.updateMany({ where: { id: workspaceId, deletedAt: null }, data: { deletedAt: new Date(), deletedById: data.deletedById, purgeAccountOfId: data.purgeAccountOfId } });
        if (r.count !== 1) return null;
        const row = await db.workspace.findFirst({ where: { id: workspaceId }, select: { deletedAt: true } });
        return row?.deletedAt ? { deletedAt: row.deletedAt } : null;
    },

    /** What a workspace holds, counted (an audit row's details: counts only). */
    async contents(db: Db, workspaceId: string): Promise<{ bookCount: number; memberCount: number }> {
        const [bookCount, memberCount] = [await db.book.count({ where: { workspaceId } }), await db.workspaceMembership.count({ where: { workspaceId } })];
        return { bookCount, memberCount };
    },

    /** The account's deleted workspaces it is an OWNER of, deleted after `since` (still restorable), newest first. */
    async restorableForOwner(db: Db, userId: string, since: Date) {
        const rows = await db.workspaceMembership.findMany({
            where: { userId, role: 'OWNER', workspace: { deletedAt: { gt: since } } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: RESTORABLE_WORKSPACES_MAX,
            select: { workspace: { select: { id: true, name: true, slug: true, deletedAt: true, purgeAccountOfId: true } } },
        });
        return rows.map((r) => r.workspace);
    },

    /** Restore a workspace deleted after `since` (inside its context): its slug, or null when it is not restorable. */
    async restore(db: Db, workspaceId: string, since: Date): Promise<string | null> {
        const r = await db.workspace.updateMany({ where: { id: workspaceId, deletedAt: { gt: since } }, data: { deletedAt: null, deletedById: null, purgeAccountOfId: null } });
        if (r.count !== 1) return null;
        return (await db.workspace.findFirst({ where: { id: workspaceId }, select: { slug: true } }))?.slug ?? null;
    },

    /** Workspaces deleted at or before `cutoff`, oldest deletion first, at most `take` (the purge's discovery). Ids only. */
    async listPurgeDue(db: Db, cutoff: Date, take: number): Promise<Array<{ id: string }>> {
        return db.workspace.findMany({ where: { deletedAt: { lte: cutoff } }, orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }], select: { id: true }, take });
    },

    /** Lock a workspace still due for purge to commit; what the purge needs of it, or null (restored, or gone). */
    async lockPurgeDue(db: Db, workspaceId: string, cutoff: Date): Promise<{ purgeAccountOfId: string | null } | null> {
        const rows = await db.$queryRaw<Array<{ purgeAccountOfId: string | null }>>`
            SELECT "purgeAccountOfId" FROM "Workspace" WHERE "id" = ${workspaceId} AND "deletedAt" IS NOT NULL AND "deletedAt" <= ${cutoff} FOR UPDATE`;
        return rows[0] ?? null;
    },

    /** Delete a workspace due for purge, for good: its cascade takes every workspace-scoped row. */
    async purge(db: Db, workspaceId: string, cutoff: Date): Promise<number> {
        return db.$executeRaw`DELETE FROM "Workspace" WHERE "id" = ${workspaceId} AND "deletedAt" IS NOT NULL AND "deletedAt" <= ${cutoff}`;
    },

    /** Delete an account (its sessions and sign-in links go by cascade; the rows it authored keep NULL as their author). */
    async deleteUser(db: Db, userId: string): Promise<number> {
        return db.$executeRaw`DELETE FROM "User" WHERE "id" = ${userId}`;
    },
};
