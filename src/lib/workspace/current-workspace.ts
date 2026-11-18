/**
 * The workspace the current request belongs to — SERVER-SIDE, and a STUB.
 *
 * Returns `null` until subphase 0.3 builds authentication and workspaces:
 * there is no session to read yet. 0.3 replaces this body (session →
 * membership → workspace) and nothing that calls it changes, because the
 * shell already renders the signed-out state for `null`.
 *
 * Kept out of `workspace-context.tsx` on purpose: that module is
 * `'use client'`, and the resolver that 0.3 writes here will read the
 * session and the database, which must never reach a client bundle.
 */
import type { WorkspaceContextValue } from './workspace-context';

export async function getCurrentWorkspace(): Promise<WorkspaceContextValue | null> {
    return null;
}
