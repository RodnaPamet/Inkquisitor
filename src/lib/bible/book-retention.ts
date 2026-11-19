/**
 * How long a deleted book can be brought back (Phase 1.H). Client-safe: the
 * delete dialog and the recently-deleted list show the date from the same
 * rule the server applies.
 *
 * A deleted book (`Book.deletedAt`) is hidden at once. For
 * `BOOK_RESTORE_DAYS` its OWNER may restore it; once that window has passed
 * it can no longer be restored, and the next daily `book-purge` job deletes
 * it and everything in it for good.
 */

export const BOOK_RESTORE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The moment a book deleted at `deletedAt` stops being restorable (and becomes due for purge). */
export function restorableUntil(deletedAt: Date): Date {
    return new Date(deletedAt.getTime() + BOOK_RESTORE_DAYS * DAY_MS);
}

/** Books deleted AFTER this moment are still restorable at `now`; those deleted at or before it are due for purge. */
export function restoreCutoff(now: Date): Date {
    return new Date(now.getTime() - BOOK_RESTORE_DAYS * DAY_MS);
}
