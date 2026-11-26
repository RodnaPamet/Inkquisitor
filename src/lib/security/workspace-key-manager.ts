/**
 * The runtime side of the per-workspace data keys: resolve a workspace's DEK
 * for the encryption extension, with an in-process cache.
 *
 * Lifted from inflect-compliance's `src/lib/security/tenant-key-manager.ts`
 * (see docs/carve-manifest.md). Inkquisitor edits:
 *
 *   - A FACTORY over a Prisma client, not a module reading a singleton. The
 *     client it is given is the UNEXTENDED base client (`src/lib/db.ts`), so a
 *     `Workspace` read here never re-enters the encryption extension, and
 *     there is no import cycle to escape with a namespace import, which is
 *     what inflect does.
 *   - No lazy DEK creation. Every workspace is created with its key in the
 *     same transaction (`createWorkspaceWithOwner`); a workspace without one
 *     is an anomaly, refused loudly rather than repaired on a read path.
 *   - No rotation job yet. `getPreviousDek` reads the column so a rotation
 *     can land without changing the read path.
 *
 * The cache holds raw keys for the life of the process, bounded at
 * `MAX_CACHE_SIZE` (insertion-order eviction). The negative cache for "no
 * previous key" expires after 30 s so a rotation in another process is seen.
 */
import type { PrismaClient } from '@prisma/client';
import { unwrapDek, type WorkspaceDek } from './workspace-keys';

const MAX_CACHE_SIZE = 1000;
const NO_PREVIOUS_TTL_MS = 30_000;

/**
 * A workspace's data key is missing or cannot be unwrapped (a corrupted
 * `encryptedDek`, a master key that does not match it). Typed so a job that
 * serves many workspaces can tell this workspace's failure from its own and
 * skip it (4.H-a): `code` is what the job logs and counts. Its message names
 * the workspace id only, never a key.
 */
export class WorkspaceKeyUnavailableError extends Error {
    readonly code = 'WORKSPACE_KEY_UNAVAILABLE';
    constructor(
        readonly workspaceId: string,
        readonly reason: 'NO_KEY' | 'UNWRAP_FAILED',
    ) {
        super(`The data key of workspace ${workspaceId} cannot be read (${reason}).`);
        this.name = 'WorkspaceKeyUnavailableError';
    }
}

export interface WorkspaceKeyManager {
    /** The workspace's DEK. Throws when the workspace or its key is missing. */
    getDek(workspaceId: string): Promise<WorkspaceDek>;
    /** The previous DEK while a rotation is in flight, else null. */
    getPreviousDek(workspaceId: string): Promise<WorkspaceDek | null>;
    /** Prime the cache with a key just created (sign-up), sparing the first unwrap. */
    prime(workspaceId: string, dek: WorkspaceDek): void;
    /** Drop one workspace's cached keys, or all of them. */
    clear(workspaceId?: string): void;
    /** Number of cached primary keys (observability, tests). */
    size(): number;
}

type KeyReader = Pick<PrismaClient, 'workspace'>;

function boundedSet(cache: Map<string, WorkspaceDek>, id: string, dek: WorkspaceDek): void {
    if (cache.size >= MAX_CACHE_SIZE && !cache.has(id)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(id, dek);
}

export function createWorkspaceKeyManager(client: KeyReader): WorkspaceKeyManager {
    const primary = new Map<string, WorkspaceDek>();
    const previous = new Map<string, WorkspaceDek>();
    const noPrevious = new Map<string, number>();

    return {
        async getDek(workspaceId) {
            const cached = primary.get(workspaceId);
            if (cached) return cached;
            const row = await client.workspace.findUnique({
                where: { id: workspaceId },
                select: { encryptedDek: true },
            });
            if (!row) throw new Error(`getDek: workspace ${workspaceId} not found`);
            if (!row.encryptedDek) throw new WorkspaceKeyUnavailableError(workspaceId, 'NO_KEY');
            let dek: WorkspaceDek;
            try {
                dek = unwrapDek(row.encryptedDek);
            } catch {
                throw new WorkspaceKeyUnavailableError(workspaceId, 'UNWRAP_FAILED');
            }
            boundedSet(primary, workspaceId, dek);
            return dek;
        },

        async getPreviousDek(workspaceId) {
            const cached = previous.get(workspaceId);
            if (cached) return cached;
            const expires = noPrevious.get(workspaceId);
            if (expires !== undefined && expires > Date.now()) return null;
            const row = await client.workspace.findUnique({
                where: { id: workspaceId },
                select: { previousEncryptedDek: true },
            });
            if (!row) throw new Error(`getPreviousDek: workspace ${workspaceId} not found`);
            if (!row.previousEncryptedDek) {
                noPrevious.set(workspaceId, Date.now() + NO_PREVIOUS_TTL_MS);
                return null;
            }
            noPrevious.delete(workspaceId);
            const dek = unwrapDek(row.previousEncryptedDek);
            boundedSet(previous, workspaceId, dek);
            return dek;
        },

        prime(workspaceId, dek) {
            boundedSet(primary, workspaceId, dek);
        },

        clear(workspaceId) {
            if (workspaceId) {
                primary.delete(workspaceId);
                previous.delete(workspaceId);
                noPrevious.delete(workspaceId);
            } else {
                primary.clear();
                previous.clear();
                noPrevious.clear();
            }
        },

        size() {
            return primary.size;
        },
    };
}
