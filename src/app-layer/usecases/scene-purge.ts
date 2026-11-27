/**
 * The daily scene purge (Phase 5.H-a, issue #71; the `scene-purge` job): delete for good every scene deleted more
 * than `SCENE_RESTORE_DAYS` (30) days ago, by the DATABASE's clock.
 *
 *   1. DISCOVERY, across workspaces, ids only: the one place a row-level security bypass is taken
 *      (`scene-purge-discovery`), reading `ManuscriptScene(id, workspaceId, bookId)` where `deletedAt` is at or before
 *      the cutoff, oldest first, at most `SCENE_PURGE_BATCH` a run (the next run takes the rest).
 *   2. Each scene is then purged in one transaction as the OWNING role (`scene-purge`: app_user holds no DELETE on the
 *      append-only version tables, and keeps none), as the system: the row is locked
 *      only if it is still due (a restore that won the race leaves it alone) and deleted — its links, card, research
 *      proposals, draft facts and mismatches, thread links and scene sessions go by cascade — then its book-keyed
 *      HISTORY (text versions, note versions, card versions, which carry no foreign key to the scene so that a live
 *      scene's history outlives nothing it should not), and a `MANUSCRIPT_SCENE_PURGED` audit row (ids and counts)
 *      commits with it. The version tables' append-only triggers admit those deletes only once the scene row is gone
 *      (the 5.H-a migration widens them to: "the scene is gone, and this transaction names it"). The audit row is appended
 *      under the workspace's row-level security (`bindWorkspaceInTransaction`), as sign-up and the workspace purge do.
 *
 * One scene's failure is logged and counted, never thrown: the others still go, and the failed one is due again
 * tomorrow. Idempotent: a scene purged once is not found again.
 */
import { randomUUID } from 'node:crypto';
import { logEvent } from '@/app-layer/events/audit';
import { ManuscriptRepository, ManuscriptSceneRepository, SceneHistoryRepository } from '@/app-layer/repositories/manuscript.repository';
import { sceneRestoreCutoff } from '@/lib/manuscript/scene-retention';
import { bindWorkspaceInTransaction, runWithoutRls } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import { safeErrorMessage } from '@/lib/observability/safe-error';

/** Scenes purged at most per run. */
export const SCENE_PURGE_BATCH = 500;

export interface ScenePurgeResult {
    due: number;
    purged: number;
    /** Due when found, but restored (or already gone) by the time it was locked. */
    skipped: number;
    failed: number;
    /** True when more scenes were due than one run takes. */
    more: boolean;
}

export async function purgeDeletedScenes(options: { batch?: number } = {}): Promise<ScenePurgeResult> {
    const batch = options.batch ?? SCENE_PURGE_BATCH;
    const due = await runWithoutRls({ reason: 'scene-purge-discovery' }, async (db) => {
        const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
        return ManuscriptSceneRepository.listPurgeDue(db, sceneRestoreCutoff(now), batch + 1);
    });
    const result: ScenePurgeResult = { due: Math.min(due.length, batch), purged: 0, skipped: 0, failed: 0, more: due.length > batch };
    for (const scene of due.slice(0, batch)) {
        const ctx = { workspaceId: scene.workspaceId, requestId: randomUUID() };
        try {
            // As the OWNING role (app_user holds no DELETE on the version tables, by design): the scene, then its history,
            // then — bound to the workspace's row-level security — the audit row, in one transaction.
            const purged = await runWithoutRls({ reason: 'scene-purge' }, (client) =>
                client.$transaction(async (db) => {
                    const cutoff = sceneRestoreCutoff(await ManuscriptRepository.dbNow(db));
                    if ((await ManuscriptSceneRepository.purge(db, scene.workspaceId, scene.bookId, scene.id, cutoff)) !== 1) return false;
                    const history = await SceneHistoryRepository.deleteForGoneScene(db, scene.workspaceId, scene.bookId, scene.id);
                    await bindWorkspaceInTransaction(db, ctx);
                    await logEvent(ctx, { action: 'MANUSCRIPT_SCENE_PURGED', entityType: 'ManuscriptScene', entityId: scene.id, details: { bookId: scene.bookId, ...history } }, { db, actorType: 'SYSTEM' });
                    return true;
                }),
            );
            if (purged) result.purged++;
            else result.skipped++;
        } catch (err) {
            result.failed++;
            logger.error('scene purge failed for one scene', { component: 'scene-purge', workspaceId: scene.workspaceId, bookId: scene.bookId, sceneId: scene.id, error: safeErrorMessage(err) });
        }
    }
    return result;
}
