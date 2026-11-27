/**
 * Workspaces. `Workspace` is row-level-secured on its own id: inside a
 * workspace context only that workspace is visible. Creation and slug
 * discovery happen before any context exists and run on the plain client
 * (`runWithoutRls`, reasons `workspace-creation` / `workspace-discovery`).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { generateAndWrapDek, type WorkspaceDek } from '@/lib/security/workspace-keys';

type Db = Prisma.TransactionClient;

export interface CreatedWorkspace {
    workspace: { id: string; slug: string; name: string };
    /** The raw data key, for priming the key cache. Never logged, never returned to a client. */
    dek: WorkspaceDek;
}

/**
 * Create a workspace WITH its data key: the DEK is generated, wrapped under
 * the master KEK and written in the same insert, so no workspace ever exists
 * without one (the key manager refuses such a workspace rather than repair it).
 */
export async function createWorkspaceWithDek(db: Db, data: { name: string; slug: string }): Promise<CreatedWorkspace> {
    const { dek, wrapped } = generateAndWrapDek();
    const workspace = await db.workspace.create({
        data: { name: data.name, slug: data.slug, encryptedDek: wrapped },
        select: { id: true, slug: true, name: true },
    });
    return { workspace, dek };
}

export const WorkspaceRepository = {
    /** The workspace's name, inside its own context (an export's cover, Phase 1.3). */
    findName(db: Db, workspaceId: string) {
        return db.workspace.findFirst({ where: { id: workspaceId }, select: { name: true } }).then((row) => row?.name ?? null);
    },

    /** The workspace's slug, inside its own context (a background job rebuilding a context, Phase 2.6). */
    findSlug(db: Db, workspaceId: string) {
        return db.workspace.findFirst({ where: { id: workspaceId }, select: { slug: true } }).then((row) => row?.slug ?? null);
    },

    findBySlug(db: Db, slug: string) {
        return db.workspace.findUnique({ where: { slug }, select: { id: true, slug: true, name: true } });
    },

    slugTaken(db: Db, slug: string) {
        return db.workspace.findUnique({ where: { slug }, select: { id: true } }).then((row) => row !== null);
    },

    /**
     * Phase 5.H-a: of these workspace ids, the ones DELETED (awaiting their purge). A job that serves every workspace
     * leaves them out after its discovery (`withoutDeletedWorkspaces`), so nothing is extracted, embedded, checked or
     * read for a workspace its OWNER asked to delete. Runs on the discovery's own bypass client; ids only.
     */
    async deletedAmong(db: PrismaClient | Db, ids: readonly string[]): Promise<Set<string>> {
        if (ids.length === 0) return new Set();
        const unique = [...new Set(ids)];
        const rows = await db.workspace.findMany({ where: { id: { in: unique }, deletedAt: { not: null } }, select: { id: true }, take: unique.length });
        return new Set(rows.map((r) => r.id));
    },
};

/** `rows` without those of a deleted workspace (5.H-a), in their order. */
export async function withoutDeletedWorkspaces<T extends { workspaceId: string }>(db: PrismaClient, rows: readonly T[]): Promise<T[]> {
    const deleted = await WorkspaceRepository.deletedAmong(db, rows.map((r) => r.workspaceId));
    return deleted.size === 0 ? [...rows] : rows.filter((r) => !deleted.has(r.workspaceId));
}
