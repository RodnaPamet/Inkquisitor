/**
 * Job executor registry — job name → executor, with fault isolation.
 *
 * Every entry point (the BullMQ worker, the in-process scheduler tick, a CLI
 * script, a test) runs a job through `executorRegistry.execute`, which never
 * throws: a failing executor becomes a `success: false` result, logged and
 * counted, so one job can never take the worker or the other jobs down.
 *
 * The registry ships EMPTY of product jobs. Its one registration is
 * `heartbeat`, a no-op that exists to prove the wiring (see `types.ts`).
 * A product job registers here, below it, with a dynamic import so its
 * dependencies load only when it first runs.
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
}

registerDefaultExecutors();
