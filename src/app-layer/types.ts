import type { PermissionSet } from '@/lib/permissions';

/**
 * The authorization context every usecase and repository receives, as its
 * FIRST argument, explicitly (there is no AsyncLocalStorage for it — the
 * observability context in `src/lib/observability/context.ts` is a separate
 * thing and never authorizes anything).
 *
 * Phase 0.4 defined the shape so the platform services (tracing, the job
 * runner, rate-limit keys) can name it. The base type keeps the identity
 * fields OPTIONAL — a background job carries none of them, a sign-in has a
 * user and no workspace — and Phase 0.3 TIGHTENS rather than loosens: a
 * workspace-scoped usecase takes a `WorkspaceRequestContext`, built only by
 * `getWorkspaceCtx` (`src/app-layer/context.ts`) from the session and a
 * database membership check, in which every workspace field is required.
 */
export type WorkspaceRole = 'OWNER' | 'EDITOR' | 'READER';

export interface RequestContext {
    /** Correlation id, the same one the observability context carries. */
    requestId: string;
    /** The authenticated user (Phase 0.3). */
    userId?: string;
    /** The workspace the request acts in (Phase 0.3, decision D4). */
    workspaceId?: string;
    /** The workspace's URL slug, when the request named one. */
    workspaceSlug?: string;
    /** The user's role in that workspace. */
    role?: WorkspaceRole;
}

/**
 * A context whose workspace has been resolved: the user is signed in, the
 * workspace exists, and the user holds a membership in it (checked against
 * the database, not the JWT). `permissions` is the role's set
 * (`src/lib/permissions.ts`).
 */
export type WorkspaceRequestContext = RequestContext & {
    userId: string;
    workspaceId: string;
    workspaceSlug: string;
    role: WorkspaceRole;
    permissions: PermissionSet;
};
