/**
 * THE NIGHTLY DRAFT-READING DISPATCHER (Phase 5.3, D35): the body of the `draft-read-dispatch` job, scheduled at
 * 03:07 UTC — after the continuity check (02:23), the two sharing one nightly budget (D35 item 2).
 *
 * It finds the live books with a scene whose text changed since it was last read, or that holds words and was never
 * read (`DraftDiscovery.listDueBooks`, the one read outside row-level security, `draft-discovery`, ids only,
 * fair-shared between workspaces and bounded by `DRAFT_DISPATCH_MAX`) and, in each book's own workspace, ends any of
 * its runs lost for `STALE_DRAFT_RUN_MS` (STOPPED CLAIM_EXPIRED, resumable), creates one QUEUED run for this night
 * (`continuityNightKey`; one a book a night, a unique key) and enqueues a `draft-read` job for it (payload ids only).
 * A book with nothing to read is not queued, so a quiet manuscript costs nothing. The kill switch, the ceiling, the
 * night's share and D11 are the run's to meet. A book whose workspace cannot be served (its data key will not unwrap)
 * is skipped, logged with its ids and a code and counted (`servedWorkspace`): every other book is still queued.
 */
import { withoutDeletedWorkspaces } from '@/app-layer/repositories/workspace.repository';
import { randomUUID } from 'node:crypto';
import { DraftDiscovery, DraftReadRunRepository } from '@/app-layer/repositories/draft-facts.repository';
import type { JobName, JobPayload } from '@/app-layer/jobs/types';
import { servedWorkspace } from '@/app-layer/jobs/workspace-isolation';
import { continuityNightKey } from '@/lib/continuity/vocabulary';
import { DRAFT_DISPATCH_MAX, STALE_DRAFT_RUN_MS } from '@/lib/draft-facts/vocabulary';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

export interface DraftReadDispatchDeps {
    enqueue?: <T extends JobName>(name: T, payload: JobPayload<T>, options?: { jobId?: string }) => Promise<unknown>;
    /** Only these workspaces (tests, which share one database). */
    workspaceIds?: readonly string[];
    now?: () => Date;
    take?: number;
    nightKey?: string;
}

export interface DraftReadDispatchResult {
    due: number;
    queued: number;
    expired: number;
    enqueueFailed: number;
    alreadyTonight: number;
    workspacesSkipped: number;
}

export async function executeDraftReadDispatch(deps: DraftReadDispatchDeps = {}): Promise<DraftReadDispatchResult> {
    const now = (deps.now ?? (() => new Date()))();
    const staleBefore = new Date(now.getTime() - STALE_DRAFT_RUN_MS);
    const enqueue = deps.enqueue ?? (async (name, payload, options) => (await import('@/app-layer/jobs/queue')).enqueue(name, payload, options));
    const result: DraftReadDispatchResult = { due: 0, queued: 0, expired: 0, enqueueFailed: 0, alreadyTonight: 0, workspacesSkipped: 0 };
    const nightKey = deps.nightKey ?? continuityNightKey(now);
    const due = await runWithoutRls({ reason: 'draft-discovery' }, async (db) => withoutDeletedWorkspaces(db, await DraftDiscovery.listDueBooks(db, { take: deps.take ?? DRAFT_DISPATCH_MAX, staleBefore, nightKey, workspaceIds: deps.workspaceIds })));
    result.due = due.length;
    for (const book of due) {
        const scope = { workspaceId: book.workspaceId, requestId: randomUUID() };
        const created = await servedWorkspace('draft-read-dispatch', { workspaceId: book.workspaceId, bookId: book.bookId }, async (): Promise<{ id: string } | 'ALREADY_TONIGHT'> => {
            try {
                return await runInWorkspaceContext(scope, async (db) => {
                    result.expired += await DraftReadRunRepository.expireStale(db, book.workspaceId, book.bookId, staleBefore, now);
                    return DraftReadRunRepository.create(db, book.workspaceId, book.bookId, nightKey);
                });
            } catch (err) {
                // A concurrent dispatch of the same night queued this book first: nothing more to do.
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
        try {
            await enqueue('draft-read', { workspaceId: book.workspaceId, runId: created.id }, { jobId: `draft-read-${created.id}` });
            result.queued++;
        } catch (err) {
            // The run stays QUEUED; with no sign of life it is ended and the book queued again once stale.
            result.enqueueFailed++;
            logger.warn('draft.enqueue_failed', { component: 'draft-facts', workspaceId: book.workspaceId, runId: created.id, error: err instanceof Error ? err.name : 'unknown' });
        }
    }
    return result;
}
