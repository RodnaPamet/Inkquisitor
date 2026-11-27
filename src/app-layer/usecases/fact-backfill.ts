/**
 * THE BACKFILL OF BIBLES SAVED BEFORE 4.1 (Phase 4.H-b; roadmap 4.H item 5,
 * decisions D31 and D32): the body of the hourly `fact-backfill` job.
 *
 * Since 4.1 every accepted version writes its own extraction row (the outbox
 * trigger). An entry last saved before 4.1 has none, so its facts were never
 * read: it answers no field through a fact, the continuity checks never see
 * it, and the retriever never offers it. This job reads those entries in the
 * background, AUTOMATICALLY (D31), resumably and under a budget:
 *
 *   DISCOVER   the workspaces with work — an entry of a live book never
 *              extracted, or a BACKFILL row due — under the closed
 *              `fact-backfill-discovery` bypass, ids only, in WORKSPACE ORDER
 *              FROM A ROUND-ROBIN CURSOR (`JobCursor`), at most
 *              `BACKFILL_WORKSPACES_PER_TICK` a tick: every such workspace is
 *              reached within a bounded number of ticks (fair share).
 *   WORKSPACE  in its own context, isolated (`servedWorkspace`: a workspace
 *              whose data key will not unwrap is skipped, logged and counted):
 *              the month must have room for the least call (the ceiling; with
 *              none the workspace waits, `deferredAtCeiling`) and the DAY must
 *              too — the backfill spends at most `BACKFILL_DAILY_SHARE` (10 %)
 *              of the workspace's monthly ceiling a day (D32), measured from the
 *              ledger by its purpose (`facts.bible-extract.backfill`: calls
 *              charged in the last 24 hours plus live reservations); with none
 *              it waits (`deferredAtShare`). And the calendar MONTH must too:
 *              at most `BACKFILL_MONTHLY_SHARE` (50 %) of the monthly ceiling
 *              in a UTC month, by the same purpose (owner decision 2026-11-27,
 *              D32); with none it waits for next month
 *              (`deferredAtMonthlyShare`). Then up to
 *              `BACKFILL_ENTRIES_PER_WORKSPACE_TICK` rows: its due BACKFILL rows
 *              first (stopped ones resumed, stale claims), then the NEWEST
 *              version of further entries never extracted, given a row now —
 *              never every historical version, and never more rows than this
 *              tick queues.
 *   QUEUE      each row marked QUEUED (the same due window, in the statement)
 *              and a `bible-facts` job enqueued (payload ids). That job reads it
 *              as any extraction (its budgets, D11, the rate minute, the kill
 *              switch), its calls recorded under the backfill's purpose and held
 *              to the daily and monthly shares by the ledger under its spend
 *              lock; past one it stops DAILY_SHARE or MONTHLY_SHARE, resumable,
 *              no attempt counted.
 *
 * Never on a request's path; nothing runs while no call can be made or no
 * evaluation record mounts (D11). Idempotent: an entry with a row is never found
 * again, a row already queued is not due, and re-running a tick whose work is
 * done gives nothing a row. The monthly ceiling stays the hard bound over this,
 * the nightly continuity check's own share and every other call.
 */
import { withoutDeletedWorkspaces } from '@/app-layer/repositories/workspace.repository';
import { randomUUID } from 'node:crypto';
import { FactBackfillRepository, FactExtractionRepository } from '@/app-layer/repositories/fact-layer.repository';
import { fromCursor, JobCursorRepository } from '@/app-layer/repositories/job-cursor.repository';
import type { JobName, JobPayload } from '@/app-layer/jobs/types';
import { servedWorkspace } from '@/app-layer/jobs/workspace-isolation';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { bibleFactsCallFloor } from '@/lib/facts/cost';
import { bibleFactGate } from '@/lib/facts/record-gate';
import { BACKFILL_DISPATCH_MAX, BACKFILL_ENTRIES_PER_WORKSPACE_TICK, BACKFILL_WORKSPACES_PER_TICK, STALE_EXTRACTION_MS } from '@/lib/facts/vocabulary';
import { logger } from '@/lib/observability/logger';
import { backfillMonthlyShare, backfillShare, backfillShareStop } from './bible-facts';
import { deploymentPackRecordMode } from './interview-packs';
import { modelBudgetState, modelUnavailableReason } from './model-calls';

/** The backfill's round-robin cursor (the last workspace it served). */
export const BACKFILL_CURSOR = 'fact-backfill:workspaces';

export interface FactBackfillDeps {
    enqueue?: <T extends JobName>(name: T, payload: JobPayload<T>, options?: { jobId?: string }) => Promise<unknown>;
    /** Is extraction possible in this deployment now? (tests) */
    extractionOpen?: () => boolean;
    /** Only these workspaces (tests, which share one database). */
    workspaceIds?: readonly string[];
    now?: () => Date;
    /** The least a bible fact call costs at worst (tests: a figure of their own). */
    callFloorMicroUsd?: () => number;
    /** The daily share in µUSD (tests: a figure of their own). */
    dailyCapMicroUsd?: number;
    /** The share of the calendar month in µUSD (tests: a figure of their own). */
    monthlyCapMicroUsd?: number;
    /** The cursor's name (tests: their own). */
    cursorName?: string;
    /** Bounds (tests: smaller ones). */
    workspacesPerTick?: number;
    entriesPerWorkspace?: number;
    dispatchMax?: number;
}

export interface FactBackfillResult {
    extractionClosed: boolean;
    /** Workspaces discovered this tick. */
    workspaces: number;
    /** Rows created (entries given a BACKFILL row) and queued. */
    created: number;
    queued: number;
    enqueueFailed: number;
    /** Workspaces whose month (or day) had no room: nothing of theirs queued this tick. */
    deferredAtCeiling: number;
    deferredAtShare: number;
    /** Workspaces whose backfill has spent its share of the calendar month (D32): nothing of theirs queued until next month. */
    deferredAtMonthlyShare: number;
    workspacesSkipped: number;
}

function defaultExtractionOpen(): boolean {
    return modelUnavailableReason() === null && bibleFactGate(deploymentPackRecordMode()).mounted;
}

/** Run one tick (the job's body). */
export async function executeFactBackfill(deps: FactBackfillDeps = {}): Promise<FactBackfillResult> {
    const now = (deps.now ?? (() => new Date()))();
    const result: FactBackfillResult = { extractionClosed: false, workspaces: 0, created: 0, queued: 0, enqueueFailed: 0, deferredAtCeiling: 0, deferredAtShare: 0, deferredAtMonthlyShare: 0, workspacesSkipped: 0 };
    if (!(deps.extractionOpen ?? defaultExtractionOpen)()) {
        result.extractionClosed = true;
        return result;
    }
    const enqueue = deps.enqueue ?? (async (name, payload, options) => (await import('@/app-layer/jobs/queue')).enqueue(name, payload, options));
    const window = { now, settledBefore: now, staleBefore: new Date(now.getTime() - STALE_EXTRACTION_MS) };
    const cursorName = deps.cursorName ?? BACKFILL_CURSOR;
    const take = deps.workspacesPerTick ?? BACKFILL_WORKSPACES_PER_TICK;
    const workspaces = await runWithoutRls({ reason: 'fact-backfill-discovery' }, async (db) => {
        const found = await fromCursor(
            await JobCursorRepository.read(db, cursorName),
            take,
            (after, n) => FactBackfillRepository.listWorkspaces(db, { ...window, take: n, after, workspaceIds: deps.workspaceIds }),
            (upTo, n) => FactBackfillRepository.listWorkspaces(db, { ...window, take: n, upTo, workspaceIds: deps.workspaceIds }),
        );
        return (await withoutDeletedWorkspaces(db, found.items)).map((w) => w.workspaceId);
    });
    result.workspaces = workspaces.length;
    const floor = (deps.callFloorMicroUsd ?? bibleFactsCallFloor)();
    let room = deps.dispatchMax ?? BACKFILL_DISPATCH_MAX;
    // The cursor moves to the last workspace this tick REACHED (served, deferred or skipped), never past one the
    // tick's room ran out before (the 4.H-b review): with a fixed window of discovered workspaces, saving the last
    // DISCOVERED one left every workspace beyond the room's reach in each window unserved, every cycle, for ever.
    let reached: string | null = null;
    for (const workspaceId of workspaces) {
        if (room <= 0) break;
        reached = workspaceId;
        const scope = { workspaceId, requestId: randomUUID() };
        const want = Math.min(room, deps.entriesPerWorkspace ?? BACKFILL_ENTRIES_PER_WORKSPACE_TICK);
        const marked = await servedWorkspace('fact-backfill', { workspaceId }, () =>
            runInWorkspaceContext(scope, async (db) => {
                const budget = await modelBudgetState(db, { workspaceId }, floor, undefined, now);
                if (budget.workspaceCeilingReached) return 'CEILING' as const;
                const stop = await backfillShareStop(db, { workspaceId }, { daily: backfillShare(now, deps.dailyCapMicroUsd), monthly: backfillMonthlyShare(now, deps.monthlyCapMicroUsd) }, floor);
                if (stop) return stop;
                // Due rows first (a stop resumed, a lost claim), then entries never extracted, never more than this tick queues.
                const due = await FactBackfillRepository.listDue(db, workspaceId, window, want);
                let created = 0;
                if (due.length < want) {
                    created = await FactBackfillRepository.createRows(db, workspaceId, await FactBackfillRepository.neverExtracted(db, workspaceId, want - due.length));
                }
                const rows = created > 0 ? await FactBackfillRepository.listDue(db, workspaceId, window, want) : due;
                const out: Array<{ id: string; attempt: number }> = [];
                for (const r of rows) if (await FactExtractionRepository.markQueued(db, workspaceId, r.id, now, window, 'BACKFILL')) out.push({ id: r.id, attempt: r.attempts + 1 });
                return { created, out };
            }),
        );
        if (marked === null) {
            result.workspacesSkipped++;
            continue;
        }
        if (marked === 'CEILING') {
            result.deferredAtCeiling++;
            continue;
        }
        if (marked === 'DAILY_SHARE') {
            result.deferredAtShare++;
            continue;
        }
        if (marked === 'MONTHLY_SHARE') {
            result.deferredAtMonthlyShare++;
            continue;
        }
        result.created += marked.created;
        room -= marked.out.length;
        for (const m of marked.out) {
            try {
                await enqueue('bible-facts', { workspaceId, extractionId: m.id }, { jobId: `bible-facts-${m.id}-${m.attempt}` });
                result.queued++;
            } catch (err) {
                // The row stays QUEUED; with no sign of life it is due again once stale.
                result.enqueueFailed++;
                logger.warn('facts.backfill_enqueue_failed', { component: 'facts', workspaceId, extractionId: m.id, error: err instanceof Error ? err.name : 'unknown' });
            }
        }
    }
    if (reached !== null) {
        const next = reached;
        await runWithoutRls({ reason: 'fact-backfill-discovery' }, (db) => JobCursorRepository.save(db, cursorName, next));
    }
    return result;
}
