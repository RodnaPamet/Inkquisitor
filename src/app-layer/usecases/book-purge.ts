/**
 * The daily book purge (Phase 1.H, the `book-purge` job): delete for good
 * every book deleted more than `BOOK_RESTORE_DAYS` (30) days ago.
 *
 *   1. DISCOVERY, across workspaces, ids only: the one place a row-level
 *      security bypass is taken (`book-purge-discovery`), reading
 *      `Book(id, workspaceId)` where `deletedAt` is at or before the cutoff,
 *      oldest first, at most `PURGE_BATCH` a run (the next run takes the rest).
 *   2. Each book is then purged in its OWN workspace's context, as a system
 *      actor, in one transaction: the row is locked only if it is still due
 *      (a restore that won the race leaves it alone), its contents are counted,
 *      the book is deleted — its elements, fields, relations, version history
 *      and vectors go by cascade, and the version table's append-only trigger
 *      admits those deletes because the book row is already gone — and a
 *      `BOOK_PURGED` audit row (ids and counts) commits with it.
 *
 * One book's failure is logged and counted, never thrown: the others still
 * go, and the failed one is due again tomorrow. Idempotent: a book purged
 * once is not found again.
 */
import { randomUUID } from 'node:crypto';
import { logEvent } from '@/app-layer/events/audit';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import { restoreCutoff } from '@/lib/bible/book-retention';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import { safeErrorMessage } from '@/lib/observability/safe-error';

/** Books purged at most per run. */
export const PURGE_BATCH = 200;
/** A large book's purge deletes tens of thousands of rows by cascade. */
const PURGE_TX_TIMEOUT_MS = 120_000;

export interface PurgeResult {
    /** Books found due. */
    due: number;
    purged: number;
    /** Due when found, but restored (or already gone) by the time it was locked. */
    skipped: number;
    failed: number;
    /** True when more books were due than one run takes. */
    more: boolean;
}

export async function purgeDeletedBooks(options: { now?: Date; batch?: number } = {}): Promise<PurgeResult> {
    const now = options.now ?? new Date();
    const batch = options.batch ?? PURGE_BATCH;
    const cutoff = restoreCutoff(now);
    const due = await runWithoutRls({ reason: 'book-purge-discovery' }, (db) => BookRepository.listPurgeDue(db, cutoff, batch + 1));
    const result: PurgeResult = { due: Math.min(due.length, batch), purged: 0, skipped: 0, failed: 0, more: due.length > batch };
    for (const book of due.slice(0, batch)) {
        const ctx = { workspaceId: book.workspaceId, requestId: randomUUID() };
        try {
            const purged = await runInWorkspaceContext(
                ctx,
                async (db) => {
                    if (!(await BookRepository.lockPurgeDue(db, book.workspaceId, book.id, cutoff))) return false;
                    const contents = await BookRepository.contents(db, book.workspaceId, book.id);
                    if ((await BookRepository.purge(db, book.workspaceId, book.id, cutoff)) !== 1) return false;
                    await logEvent(ctx, { action: 'BOOK_PURGED', entityType: 'Book', entityId: book.id, details: contents }, { db, actorType: 'SYSTEM' });
                    return true;
                },
                { timeout: PURGE_TX_TIMEOUT_MS },
            );
            if (purged) result.purged++;
            else result.skipped++;
        } catch (err) {
            result.failed++;
            logger.error('book purge failed for one book', { component: 'book-purge', workspaceId: book.workspaceId, bookId: book.id, error: safeErrorMessage(err) });
        }
    }
    return result;
}
