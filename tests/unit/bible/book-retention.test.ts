/**
 * The 30-day restore window is one number in two places (Phase 1.H): the
 * product's rule (`BOOK_RESTORE_DAYS`) and the database trigger that refuses
 * deleting a book for good before it (`book_delete_only_when_purge_due`).
 * Changing one without the other would let the purge be refused every day,
 * or let a restorable book be deleted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BOOK_RESTORE_DAYS, restorableUntil, restoreCutoff } from '@/lib/bible/book-retention';
import { REPO_ROOT, repoRelativeFiles } from '../../helpers/repo-files';

it('the trigger’s interval is BOOK_RESTORE_DAYS', () => {
    const migrations = repoRelativeFiles().filter((f) => /^prisma\/migrations\/.*\/migration\.sql$/.test(f));
    const defining = migrations.filter((f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').includes('FUNCTION book_delete_only_when_purge_due()'));
    expect(defining).toHaveLength(1);
    const sql = fs.readFileSync(path.join(REPO_ROOT, defining[0]), 'utf8');
    const body = sql.slice(sql.indexOf('FUNCTION book_delete_only_when_purge_due()'));
    expect([...body.matchAll(/interval '(\d+) days'/g)].map((m) => Number(m[1]))).toEqual([BOOK_RESTORE_DAYS]);
});

it('a book is restorable for exactly the window, and due for purge at its end', () => {
    const deletedAt = new Date('2026-11-01T12:00:00.000Z');
    expect(restorableUntil(deletedAt).toISOString()).toBe('2026-12-01T12:00:00.000Z');
    expect(restoreCutoff(restorableUntil(deletedAt)).getTime()).toBe(deletedAt.getTime());
});
