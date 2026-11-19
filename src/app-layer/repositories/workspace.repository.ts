/**
 * Workspaces. `Workspace` is row-level-secured on its own id: inside a
 * workspace context only that workspace is visible. Creation and slug
 * discovery happen before any context exists and run on the plain client
 * (`runWithoutRls`, reasons `workspace-creation` / `workspace-discovery`).
 */
import type { Prisma } from '@prisma/client';
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
    findBySlug(db: Db, slug: string) {
        return db.workspace.findUnique({ where: { slug }, select: { id: true, slug: true, name: true } });
    },

    slugTaken(db: Db, slug: string) {
        return db.workspace.findUnique({ where: { slug }, select: { id: true } }).then((row) => row !== null);
    },
};
