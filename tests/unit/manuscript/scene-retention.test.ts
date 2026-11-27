/**
 * The 30-day restore window of a deleted scene is one number in two places (Phase 5.H-a, issue #71): the product's
 * rule (`SCENE_RESTORE_DAYS`) and the trigger that refuses deleting a scene for good before it
 * (`manuscript_scene_delete_only_when_purge_due`). The workspace's window (D36) is the purge job's own rule, held here
 * to the same 30 days the owner decided.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCENE_RESTORE_DAYS, sceneRestorableUntil, sceneRestoreCutoff } from '@/lib/manuscript/scene-retention';
import { WORKSPACE_RESTORE_DAYS, workspaceRestorableUntil, workspaceRestoreCutoff } from '@/lib/workspace/workspace-retention';
import { REPO_ROOT, repoRelativeFiles } from '../../helpers/repo-files';

function functionBody(name: string): string {
    const migrations = repoRelativeFiles().filter((f) => /^prisma\/migrations\/.*\/migration\.sql$/.test(f));
    const defining = migrations.filter((f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').includes(`FUNCTION ${name}()`));
    expect(defining).toHaveLength(1);
    const sql = fs.readFileSync(path.join(REPO_ROOT, defining[0]), 'utf8');
    const start = sql.indexOf(`FUNCTION ${name}()`);
    return sql.slice(start, sql.indexOf('$$;', start));
}

it('the scene trigger’s interval is SCENE_RESTORE_DAYS', () => {
    expect([...functionBody('manuscript_scene_delete_only_when_purge_due').matchAll(/interval '(\d+) days'/g)].map((m) => Number(m[1]))).toEqual([SCENE_RESTORE_DAYS]);
});

it('a scene is restorable for exactly the window, and due for purge at its end', () => {
    const deletedAt = new Date('2026-11-01T12:00:00.000Z');
    expect(sceneRestorableUntil(deletedAt).toISOString()).toBe('2026-12-01T12:00:00.000Z');
    expect(sceneRestoreCutoff(sceneRestorableUntil(deletedAt)).getTime()).toBe(deletedAt.getTime());
});

it('a workspace is restorable for 30 days (D36), and due for purge at its end', () => {
    expect(WORKSPACE_RESTORE_DAYS).toBe(30);
    const deletedAt = new Date('2026-11-01T12:00:00.000Z');
    expect(workspaceRestorableUntil(deletedAt).toISOString()).toBe('2026-12-01T12:00:00.000Z');
    expect(workspaceRestoreCutoff(workspaceRestorableUntil(deletedAt)).getTime()).toBe(deletedAt.getTime());
});
