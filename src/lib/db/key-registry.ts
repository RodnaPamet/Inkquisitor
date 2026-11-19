/**
 * Which workspace key manager serves which Prisma client, for the clients
 * that carry the field-encryption extension.
 *
 * `runInWorkspaceContext` (./rls-middleware.ts) looks its client up here and
 * resolves the workspace's data key BEFORE it opens the transaction. The key
 * manager reads `Workspace.encryptedDek` on a pooled connection of its own;
 * doing that from inside the transaction (the extension's lazy lookup) holds
 * one connection while waiting for another, and a small or busy pool
 * deadlocks until the transaction times out.
 *
 * A client without the extension (the shipped, empty manifest) is never
 * registered, so it pays no key lookup. A leaf module: `src/lib/db.ts`
 * registers, the RLS middleware reads, neither imports the other through it.
 */
import type { WorkspaceKeyManager } from '@/lib/security/workspace-key-manager';

const registry = new WeakMap<object, WorkspaceKeyManager>();

export function registerWorkspaceKeys(client: object, keys: WorkspaceKeyManager): void {
    registry.set(client, keys);
}

export function workspaceKeysFor(client: object): WorkspaceKeyManager | undefined {
    return registry.get(client);
}
