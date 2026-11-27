/**
 * How long a deleted workspace can be brought back (Phase 5.H-a, D36: full
 * deletion within 30 days). Client-safe: the deletion dialog and the account's
 * list of deleted workspaces show the date from the same rule the server
 * applies.
 *
 * An OWNER's deletion (`Workspace.deletedAt`) closes the workspace at once to
 * every member and to the background jobs. For `WORKSPACE_RESTORE_DAYS` one of
 * its OWNERs may restore it whole; once that window has passed the next daily
 * `workspace-purge` job deletes it — every row it holds, its vectors, its
 * stored objects and its queued jobs, and the requesting OWNER's account when
 * they asked and belong to no other workspace — within a day of the deadline,
 * so within 31 days of the request at the latest. The window is the DATABASE's
 * clock.
 */

export const WORKSPACE_RESTORE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The moment a workspace deleted at `deletedAt` stops being restorable (and becomes due for purge). */
export function workspaceRestorableUntil(deletedAt: Date): Date {
    return new Date(deletedAt.getTime() + WORKSPACE_RESTORE_DAYS * DAY_MS);
}

/** Workspaces deleted AFTER this moment are restorable at `now`; those deleted at or before it are due for purge. */
export function workspaceRestoreCutoff(now: Date): Date {
    return new Date(now.getTime() - WORKSPACE_RESTORE_DAYS * DAY_MS);
}
