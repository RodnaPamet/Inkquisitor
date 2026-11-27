/**
 * Scheduling a scene's prose check (Phase 5.2, D34 item 1): after a save that
 * changed the text, the check runs a few seconds after the author stops typing,
 * in the worker, never on the request.
 *
 * DEBOUNCED BY THE QUEUE. Each request adds a `prose-check` job (payload ids
 * only) with BullMQ's deduplication keyed on the scene (`prose-check-<sceneId>`),
 * `reschedule` and `keepLastIfActive`: a save while the scene's job is still
 * waiting MOVES it to `PROSE_CHECK_DEBOUNCE_MS` after this save (so a burst of
 * autosaves is one check, after the last), and a save while it RUNS is kept and
 * queued once it finishes (so the newest text is always checked). A plain
 * per-scene `jobId` would not do: BullMQ silently ignores an add whose id a
 * running or retained job holds, which would lose the newest save's check.
 *
 * NEVER FAILS A SAVE. The text is already committed when this runs; a queue
 * that cannot be reached is logged (ids only) and answered `UNAVAILABLE`, and
 * the editor's "not checked" state offers the check again.
 *
 * Nothing here reads author text, and nothing in this module's import graph
 * reaches the model layer (D3: it is imported by the scene usecases).
 */
import { env } from '@/env';
import { enqueue } from '@/app-layer/jobs/queue';
import { logger } from '@/lib/observability/logger';
import { safeErrorMessage } from '@/lib/observability/safe-error';
import { PROSE_CHECK_DEBOUNCE_MS } from '@/lib/prose-checks/vocabulary';

/** SCHEDULED; UNAVAILABLE (the queue could not be reached); OFF (`PROSE_CHECKS=off`: nothing is queued). */
export type ProseCheckScheduled = 'SCHEDULED' | 'UNAVAILABLE' | 'OFF';

export type EnqueueProseCheck = (payload: { workspaceId: string; sceneId: string }, opts: { delay: number; deduplication: { id: string; reschedule: true; keepLastIfActive: true } }) => Promise<unknown>;

/** The deduplication id of a scene's check (no colon: BullMQ's ids split on them). */
export function proseCheckDedupId(sceneId: string): string {
    return `prose-check-${sceneId}`;
}

export const defaultEnqueueProseCheck: EnqueueProseCheck = (payload, opts) => enqueue('prose-check', payload, opts);

export async function scheduleProseCheck(
    workspaceId: string,
    sceneId: string,
    opts: { delayMs?: number; enqueue?: EnqueueProseCheck } = {},
): Promise<ProseCheckScheduled> {
    if (!opts.enqueue && env.PROSE_CHECKS === 'off') return 'OFF';
    try {
        await (opts.enqueue ?? defaultEnqueueProseCheck)(
            { workspaceId, sceneId },
            { delay: Math.max(0, opts.delayMs ?? PROSE_CHECK_DEBOUNCE_MS), deduplication: { id: proseCheckDedupId(sceneId), reschedule: true, keepLastIfActive: true } },
        );
        return 'SCHEDULED';
    } catch (err) {
        logger.warn('prose check not scheduled', { component: 'prose-checks', workspaceId, sceneId, error: safeErrorMessage(err) });
        return 'UNAVAILABLE';
    }
}
