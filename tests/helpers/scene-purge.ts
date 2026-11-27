/**
 * Phase 5.H-a (issue #71): backdate a deleted scene past its 30-day window, as the superuser (for app_user the
 * database stamps `deletedAt` with its own clock), so a test can run the purge over it.
 */
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { purgeDeletedScenes } from '@/app-layer/usecases/scene-purge';

export async function backdateSceneDeletion(sceneId: string, days = 31): Promise<void> {
    await runWithoutRls({ reason: 'test' }, (db) => db.$executeRaw`UPDATE "ManuscriptScene" SET "deletedAt" = (now() AT TIME ZONE 'UTC') - make_interval(days => ${days}) WHERE "id" = ${sceneId} AND "deletedAt" IS NOT NULL`);
}

/** Backdate, then purge (every due scene); the purge's result. */
export async function purgeScene(sceneId: string) {
    await backdateSceneDeletion(sceneId);
    return purgeDeletedScenes();
}
