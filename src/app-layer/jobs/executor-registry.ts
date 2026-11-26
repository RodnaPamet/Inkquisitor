/**
 * Job executor registry — job name → executor, with fault isolation.
 *
 * Every entry point (the BullMQ worker, the in-process scheduler tick, a CLI
 * script, a test) runs a job through `executorRegistry.execute`, which never
 * throws: a failing executor becomes a `success: false` result, logged and
 * counted, so one job can never take the worker or the other jobs down.
 *
 * `heartbeat` is a no-op that exists to prove the wiring (see `types.ts`);
 * `book-purge` (Phase 1.H) is the first product job. A product job registers
 * here, below them, with a dynamic import so its dependencies load only when
 * it first runs.
 *
 * Adapted from inflect-compliance's `src/app-layer/jobs/executor-registry.ts`
 * (its ~60 compliance registrations and the integration retry-bypass are not
 * carried).
 */
import { logger } from '@/lib/observability/logger';
import { recordJobMetrics } from '@/lib/observability/metrics';
import { runJob } from '@/lib/observability/job-runner';
import { safeErrorMessage } from '@/lib/observability/safe-error';
import type { JobName, JobPayload, JobRunResult } from './types';

/** Hooks the BullMQ worker passes; cron and CLI callers pass none. */
export interface JobExecutorContext {
    updateProgress?: (progress: unknown) => Promise<void>;
}

export type JobExecutor<T extends JobName> = (payload: JobPayload<T>, ctx?: JobExecutorContext) => Promise<JobRunResult>;

// Payload erased to `never` on store (every concrete executor is assignable
// to it) and re-narrowed on lookup, where `name: T` makes the cast sound.
type StoredExecutor = JobExecutor<never>;
const executors = new Map<string, StoredExecutor>();

function failure(name: string, jobRunId: string, startedAt: string, durationMs: number, errorMessage: string): JobRunResult {
    return {
        jobName: name,
        jobRunId,
        success: false,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs,
        itemsScanned: 0,
        itemsActioned: 0,
        itemsSkipped: 0,
        errorMessage,
    };
}

export const executorRegistry = {
    register<T extends JobName>(name: T, executor: JobExecutor<T>): void {
        if (executors.has(name)) {
            throw new Error(`Duplicate executor registration for job "${name}". Each job has exactly one executor.`);
        }
        executors.set(name, executor as StoredExecutor);
    },

    /** Run a job. Always resolves; never throws. */
    async execute<T extends JobName>(name: T, payload: JobPayload<T>, ctx?: JobExecutorContext): Promise<JobRunResult> {
        const executor = executors.get(name) as JobExecutor<T> | undefined;
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const jobRunId = crypto.randomUUID();

        if (!executor) {
            logger.error('no executor registered for job', { component: 'executor-registry', jobName: name });
            return failure(name, jobRunId, startedAt, 0, `No executor registered for job "${name}"`);
        }
        try {
            const result = await executor(payload, ctx);
            recordJobMetrics({ jobName: name, success: result.success, durationMs: result.durationMs });
            return result;
        } catch (error) {
            const durationMs = Math.round(performance.now() - startMs);
            // The failure reason is logged, stored by BullMQ in Redis and
            // shown to an operator: only an AppError's own message is.
            const errorMessage = safeErrorMessage(error);
            logger.error('job executor threw', { component: 'executor-registry', jobName: name, jobRunId, durationMs, error: errorMessage });
            recordJobMetrics({ jobName: name, success: false, durationMs });
            return failure(name, jobRunId, startedAt, durationMs, errorMessage);
        }
    },

    has(name: string): boolean {
        return executors.has(name);
    },

    listRegistered(): string[] {
        return Array.from(executors.keys());
    },

    /** @internal test-only: clear, then re-register the defaults unless told not to. */
    _reset(withDefaults = true): void {
        executors.clear();
        if (withDefaults) registerDefaultExecutors();
    },
};

/** A result for an executor that scanned and actioned nothing. */
export function emptyResult(jobName: string, startedAt: string, startMs: number): JobRunResult {
    return {
        jobName,
        jobRunId: crypto.randomUUID(),
        success: true,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - startMs),
        itemsScanned: 0,
        itemsActioned: 0,
        itemsSkipped: 0,
    };
}

// ─── Registrations ───────────────────────────────────────────────────

function registerDefaultExecutors(): void {
    // The no-op. Completing it is the evidence: the worker pulled a job off
    // the queue, ran an executor and came back, and its `completed` event
    // refreshes the heartbeat key.
    executorRegistry.register('heartbeat', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('heartbeat', async () => emptyResult('heartbeat', startedAt, startMs));
    });

    // Phase 1.H: books deleted more than 30 days ago, deleted for good.
    executorRegistry.register('book-purge', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('book-purge', async () => {
            const { purgeDeletedBooks } = await import('@/app-layer/usecases/book-purge');
            const r = await purgeDeletedBooks();
            return {
                ...emptyResult('book-purge', startedAt, startMs),
                success: r.failed === 0,
                itemsScanned: r.due,
                itemsActioned: r.purged,
                itemsSkipped: r.skipped,
                ...(r.failed > 0 ? { errorMessage: `${r.failed} book(s) could not be purged` } : {}),
                details: { failed: r.failed, more: r.more },
            };
        });
    });

    // Phase 2.H: call records past their retention, deleted (issue #30 item 4).
    executorRegistry.register('ai-call-log-retention', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('ai-call-log-retention', async () => {
            const { purgeExpiredAiCallLogs } = await import('@/app-layer/usecases/ai-call-retention');
            const r = await purgeExpiredAiCallLogs();
            return {
                ...emptyResult('ai-call-log-retention', startedAt, startMs),
                success: true,
                itemsActioned: r.deleted,
                details: { days: r.days, more: r.more },
            };
        });
    });

    // Phase 2.6: one research run, named by id (decision D9).
    executorRegistry.register('research-run', async (payload) => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('research-run', async () => {
            const { executeResearchRun } = await import('@/app-layer/usecases/research-run');
            const r = await executeResearchRun(payload);
            return {
                ...emptyResult('research-run', startedAt, startMs),
                itemsScanned: 1,
                itemsActioned: r.ran ? 1 : 0,
                itemsSkipped: r.ran ? 0 : 1,
                details: { runId: payload.runId, outcome: r.outcome },
            };
        });
    });

    // Phase 4.0: one source ingestion, named by id (decision D23).
    executorRegistry.register('source-ingest', async (payload) => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('source-ingest', async () => {
            const { executeSourceIngest } = await import('@/app-layer/usecases/source-ingest');
            const { jobShutdownSignal } = await import('./shutdown-signal');
            // #57 item 6: the worker's shutdown aborts the ingestion at its next chunk (STOPPED ABORTED, resumable).
            const r = await executeSourceIngest(payload, { signal: jobShutdownSignal() });
            return {
                ...emptyResult('source-ingest', startedAt, startMs),
                itemsScanned: 1,
                itemsActioned: r.ran ? 1 : 0,
                itemsSkipped: r.ran ? 0 : 1,
                details: { sourceId: payload.sourceId, outcome: r.outcome },
            };
        });
    });

    // Phase 4.1 (D27): the fact layer's minutely dispatcher, and one bible fact extraction per accepted version.
    executorRegistry.register('fact-layer-dispatch', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('fact-layer-dispatch', async () => {
            const { executeFactLayerDispatch } = await import('@/app-layer/usecases/fact-layer-dispatch');
            const r = await executeFactLayerDispatch();
            return {
                ...emptyResult('fact-layer-dispatch', startedAt, startMs),
                itemsScanned: r.queued + r.enqueueFailed + r.embedded + r.embedDropped + r.embedFailed,
                itemsActioned: r.queued + r.embedded,
                itemsSkipped: r.embedDropped + r.workspacesSkipped,
                details: { ...r },
            };
        });
    });

    executorRegistry.register('bible-facts', async (payload) => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('bible-facts', async () => {
            const { executeBibleFactExtraction } = await import('@/app-layer/usecases/bible-facts');
            const { jobShutdownSignal } = await import('./shutdown-signal');
            const r = await executeBibleFactExtraction(payload, { signal: jobShutdownSignal() });
            return {
                ...emptyResult('bible-facts', startedAt, startMs),
                itemsScanned: 1,
                itemsActioned: r.ran ? 1 : 0,
                itemsSkipped: r.ran ? 0 : 1,
                details: { extractionId: payload.extractionId, outcome: r.outcome },
            };
        });
    });

    // Phase 4.2 (D28): the nightly continuity dispatcher, and one book's night per run.
    executorRegistry.register('continuity-dispatch', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('continuity-dispatch', async () => {
            const { executeContinuityDispatch } = await import('@/app-layer/usecases/continuity-dispatch');
            const r = await executeContinuityDispatch();
            return {
                ...emptyResult('continuity-dispatch', startedAt, startMs),
                itemsScanned: r.due,
                itemsActioned: r.queued,
                itemsSkipped: r.enqueueFailed + r.workspacesSkipped,
                details: { ...r },
            };
        });
    });

    executorRegistry.register('continuity-check', async (payload) => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('continuity-check', async () => {
            const { executeContinuityCheck } = await import('@/app-layer/usecases/continuity-check');
            const { jobShutdownSignal } = await import('./shutdown-signal');
            const r = await executeContinuityCheck(payload, { signal: jobShutdownSignal() });
            return {
                ...emptyResult('continuity-check', startedAt, startMs),
                itemsScanned: 1,
                itemsActioned: r.ran ? 1 : 0,
                itemsSkipped: r.ran ? 0 : 1,
                details: { runId: payload.runId, outcome: r.outcome },
            };
        });
    });

    // Phase 4.3 (D29): one stress test, named by id, run once the author confirmed its cost.
    executorRegistry.register('stress-test', async (payload) => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        return runJob('stress-test', async () => {
            const { executeStressTest } = await import('@/app-layer/usecases/stress-tests');
            const { jobShutdownSignal } = await import('./shutdown-signal');
            const r = await executeStressTest(payload, { signal: jobShutdownSignal() });
            return {
                ...emptyResult('stress-test', startedAt, startMs),
                itemsScanned: 1,
                itemsActioned: r.ran ? 1 : 0,
                itemsSkipped: r.ran ? 0 : 1,
                details: { stressTestId: payload.stressTestId, outcome: r.outcome },
            };
        });
    });
}

registerDefaultExecutors();
