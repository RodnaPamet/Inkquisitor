'use client';

/**
 * THE WORKSPACE CONTEXT — the one context the UI shell reads.
 *
 * inflect-compliance threads two contexts through its chrome
 * (`tenant-context-provider.tsx` and `org-context-provider.tsx`) because it
 * has tenants inside organisations. Inkquisitor has one workspace per author
 * (owner decision D4), so the pair collapses into this single context.
 *
 * THIS INTERFACE IS A CONTRACT WITH SUBPHASE 0.3. 0.3 (auth, workspaces, RLS)
 * replaces what feeds the provider — today nothing does, and every layout
 * passes `value={null}` — but it must not have to change a consumer. Keep the
 * exported names and shapes exactly as they are:
 *
 *   WorkspaceRole, WorkspaceContextValue, WorkspaceProvider, useWorkspace,
 *   useOptionalWorkspace.
 *
 * `tests/rendered/workspace-context.test.tsx` holds the behaviour.
 *
 * `null` is a real state, not an error: it is what a signed-out visitor, or
 * the pre-0.3 stub, provides. Shell components read `useOptionalWorkspace()`
 * and render a signed-out-safe state for it. Only code that cannot mean
 * anything without a workspace (a book page, later) calls `useWorkspace()`,
 * which throws rather than inventing one.
 */

import { createContext, useContext, type ReactNode } from 'react';

export type WorkspaceRole = 'OWNER' | 'EDITOR' | 'READER';

export interface WorkspaceContextValue {
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
    role: WorkspaceRole;
    userId: string;
    userName: string | null;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
WorkspaceContext.displayName = 'WorkspaceContext';

export function WorkspaceProvider(props: { value: WorkspaceContextValue | null; children: ReactNode }) {
    return <WorkspaceContext.Provider value={props.value}>{props.children}</WorkspaceContext.Provider>;
}

/**
 * The current workspace. Throws outside a provider, and inside one whose
 * value is `null`: a caller that needs a workspace must not render without
 * one, and a silent placeholder would let it.
 */
export function useWorkspace(): WorkspaceContextValue {
    const value = useContext(WorkspaceContext);
    if (value === null) {
        throw new Error(
            'useWorkspace() was called with no workspace: render it inside a <WorkspaceProvider> ' +
                'whose value is not null, or call useOptionalWorkspace() and handle the signed-out state.',
        );
    }
    return value;
}

/** The current workspace, or `null` when signed out or outside a provider. */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
    return useContext(WorkspaceContext);
}
