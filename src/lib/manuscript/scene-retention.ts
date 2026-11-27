/**
 * How long a deleted scene can be brought back (Phase 5.H-a, issue #71).
 * Client-safe: the manuscript's Recently deleted list shows the date from the
 * same rule the server applies.
 *
 * A deleted scene (`ManuscriptScene.deletedAt`) is hidden at once from every
 * list and read. For `SCENE_RESTORE_DAYS` the author may restore it with its
 * text, note, card, links, versions and research proposals; once that window
 * has passed the next daily `scene-purge` job deletes it and everything it
 * holds for good. The window is judged by the DATABASE's clock (the deletion
 * is stamped by it, and the restore and the purge read it).
 *
 * The migration's trigger `manuscript_scene_delete_only_when_purge_due` spells
 * the same 30 days; `tests/unit/manuscript/scene-retention.test.ts` holds the
 * two equal.
 */

export const SCENE_RESTORE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The moment a scene deleted at `deletedAt` stops being restorable (and becomes due for purge). */
export function sceneRestorableUntil(deletedAt: Date): Date {
    return new Date(deletedAt.getTime() + SCENE_RESTORE_DAYS * DAY_MS);
}

/** Scenes deleted AFTER this moment are still restorable at `now`; those deleted at or before it are due for purge. */
export function sceneRestoreCutoff(now: Date): Date {
    return new Date(now.getTime() - SCENE_RESTORE_DAYS * DAY_MS);
}
