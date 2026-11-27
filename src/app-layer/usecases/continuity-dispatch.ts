/**
 * THE NIGHTLY CONTINUITY DISPATCHER (Phase 4.2, D28): the body of the
 * `continuity-dispatch` job, scheduled once a night.
 *
 * It finds the live books CHANGED since their last complete deep check (a fact
 * written or a book-library source fact confirmed since, or a pass under way:
 * `ContinuityDiscovery.listDueBooks`, the one read outside row-level security,
 * `continuity-discovery`, ids only, fair-shared between workspaces and bounded
 * by `CONTINUITY_DISPATCH_MAX`) and, in each book's own workspace, ends any of
 * its runs lost for `STALE_CONTINUITY_RUN_MS` (STOPPED CLAIM_EXPIRED,
 * resumable), creates one QUEUED run and enqueues a `continuity-check` job for
 * it (payload ids only). A book unchanged since its last pass is not queued at
 * all, so a quiet book costs nothing. A book already queued for THIS night
 * (`continuityNightKey`, held by a partial unique index) is not queued again by
 * a second dispatch (4.H-a, #62 item 4). The kill switch, the ceiling and D11 are
 * the run's to meet: its rules still run, and its deep step stops resumably.
 * A book whose last pass passed subjects over (D32) is due again a week after
 * its last run even when nothing changed, so they are retried.
 * A book whose workspace cannot be served (its data key will not unwrap) is
 * skipped, logged with its ids and a code and counted (`servedWorkspace`,
 * 4.H-a): every other book is still queued.
 */
import { randomUUID } from 'node:crypto';
import { ContinuityDiscovery, ContinuityRunRepository } from '@/app-layer/repositories/continuity.repository';
import type { JobName, JobPayload } from '@/app-layer/jobs/types';
import { servedWorkspace } from '@/app-layer/jobs/workspace-isolation';
import { CONTINUITY_DISPATCH_MAX, CONTINUITY_PASSED_OVER_RETRY_MS, continuityNightKey, STALE_CONTINUITY_RUN_MS } from '@/lib/continuity/vocabulary';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

export interface ContinuityDispatchDeps {
    enqueue?: <T extends JobName>(name: T, payload: JobPayload<T>, options?: { jobId?: string }) => Promise<unknown>;
    /** Only these workspaces (tests, which share one database). */
    workspaceIds?: readonly string[];
    now?: () => Date;
    /** Books queued at most (tests: a smaller bound than `CONTINUITY_DISPATCH_MAX`). */
    take?: number;
    /** The night this dispatch is for (default `continuityNightKey(now)`; tests simulating several nights name each). */
    nightKey?: string;
}

export interface ContinuityDispatchResult {
    due: number;
    queued: number;
    expired: number;
    enqueueFailed: number;
    /** 4.H-a: books another dispatch of the same night queued first (the unique index answered). */
    alreadyTonight: number;
    /** 4.H-a: books whose workspace could not be served (logged and counted; every other book was queued). */
    workspacesSkipped: number;
}

export async function executeContinuityDispatch(deps: ContinuityDispatchDeps = {}): Promise<ContinuityDispatchResult> {
    const now = (deps.now ?? (() => new Date()))();
    const staleBefore = new Date(now.getTime() - STALE_CONTINUITY_RUN_MS);
    const enqueue = deps.enqueue ?? (async (name, payload, options) => (await import('@/app-layer/jobs/queue')).enqueue(name, payload, options));
    const result: ContinuityDispatchResult = { due: 0, queued: 0, expired: 0, enqueueFailed: 0, alreadyTonight: 0, workspacesSkipped: 0 };
    const nightKey = deps.nightKey ?? continuityNightKey(now);
    const due = await runWithoutRls({ reason: 'continuity-discovery' }, (db) => ContinuityDiscovery.listDueBooks(db, { take: deps.take ?? CONTINUITY_DISPATCH_MAX, staleBefore, nightKey, workspaceIds: deps.workspaceIds, retryBefore: new Date(now.getTime() - CONTINUITY_PASSED_OVER_RETRY_MS) }));
    result.due = due.length;
    for (const book of due) {
        const scope = { workspaceId: book.workspaceId, requestId: randomUUID() };
        const created = await servedWorkspace('continuity-dispatch', { workspaceId: book.workspaceId, bookId: book.bookId }, async (): Promise<{ id: string } | 'ALREADY_TONIGHT'> => {
            try {
                return await runInWorkspaceContext(scope, async (db) => {
                    const expired = await ContinuityRunRepository.expireStale(db, book.workspaceId, book.bookId, staleBefore, now);
                    const row = await ContinuityRunRepository.create(db, book.workspaceId, book.bookId, nightKey);
                    result.expired += expired;
                    return row;
                });
            } catch (err) {
                // A concurrent dispatch of the same night queued this book first (4.H-a, #62 item 4): nothing more to do.
                if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') return 'ALREADY_TONIGHT';
                throw err;
            }
        });
        if (created === null) {
            result.workspacesSkipped++;
            continue;
        }
        if (created === 'ALREADY_TONIGHT') {
            result.alreadyTonight++;
            continue;
        }
        const run = created;
        try {
            await enqueue('continuity-check', { workspaceId: book.workspaceId, runId: run.id }, { jobId: `continuity-check-${run.id}` });
            result.queued++;
        } catch (err) {
            // The run stays QUEUED; with no sign of life it is ended and the book queued again once stale.
            result.enqueueFailed++;
            logger.warn('continuity.enqueue_failed', { component: 'continuity', workspaceId: book.workspaceId, runId: run.id, error: err instanceof Error ? err.name : 'unknown' });
        }
    }
    return result;
}
