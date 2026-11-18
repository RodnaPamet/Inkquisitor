/**
 * The authorization context every usecase and repository receives, as its
 * FIRST argument, explicitly (there is no AsyncLocalStorage for it — the
 * observability context in `src/lib/observability/context.ts` is a separate
 * thing and never authorizes anything).
 *
 * Phase 0.4 defines the shape so the platform services (tracing, the job
 * runner, rate-limit keys) can name it; Phase 0.3 builds it from the session
 * and fills the workspace fields. Until then a request carries only its id,
 * and a background job carries none of the identity fields.
 *
 * Optional on purpose, so 0.3 can tighten rather than re-shape: a
 * workspace-scoped usecase will take a `WorkspaceRequestContext`, in which
 * the workspace fields are required.
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

/** A context whose workspace has been resolved. */
export type WorkspaceRequestContext = RequestContext & {
    userId: string;
    workspaceId: string;
    role: WorkspaceRole;
};
