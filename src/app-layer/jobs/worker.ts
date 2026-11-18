/**
 * The BullMQ Worker that consumes the job queue.
 *
 * `scripts/worker.ts` is the process (bootstrap, signals, schedules); this is
 * the Worker itself, a function so an integration test can run the real
 * processor against a real Redis on a queue of its own.
 *
 * Per job: read and strip the trace carrier, run the executor through the
 * registry inside an `execute <name>` span parented on the enqueue span, and
 * turn a `success: false` result into a throw so BullMQ records the failure
 * (an `UnrecoverableError` when the result says `noRetry`). A job name with
 * no executor is skipped with a warning rather than failed. Every completed
 * job refreshes the heartbeat key.
 *
 * The log line about a job carries its name, id, attempt and duration, never
 * its payload: payloads name rows, but a field added later must not be able
 * to reach a log line by being there.
 *
 * Adapted from the processor in inflect-compliance's `scripts/worker.ts`.
 */
import { Worker, UnrecoverableError, type Job, type ConnectionOptions } from 'bullmq';
import type Redis from 'ioredis';
import type pino from 'pino';
import { readTraceCarrier, runJobInTraceContext, stripTraceCarrier } from '@/lib/observability/job-trace';
import { safeErrorMeta } from '@/lib/observability/safe-error';
import { executorRegistry } from './executor-registry';
import { beat } from './heartbeat';
import { QUEUE_NAME, type JobName, type JobPayload } from './types';

export interface JobWorkerOptions {
    connection: Redis;
    log: pino.Logger;
    queueName?: string;
    concurrency?: number;
}

export function createJobWorker({ connection, log, queueName = QUEUE_NAME, concurrency = 5 }: JobWorkerOptions): Worker {
    const worker = new Worker(
        queueName,
        async (job: Job) => {
            const jobName = job.name as JobName;
            if (!executorRegistry.has(jobName)) {
                log.warn({ jobName, jobId: job.id }, 'no executor registered for job — skipping');
                return { skipped: true };
            }
            return runJobInTraceContext(
                readTraceCarrier(job.data),
                `execute ${jobName}`,
                {
                    'job.name': jobName,
                    'job.id': job.id ?? 'unknown',
                    'job.attempts': job.attemptsMade,
                    'messaging.system': 'bullmq',
                    'messaging.destination.name': queueName,
                    'messaging.operation': 'process',
                },
                async () => {
                    const startTime = performance.now();
                    const payload = stripTraceCarrier((job.data ?? {}) as Record<string, unknown>);
                    log.info({ jobName, jobId: job.id }, 'processing job');
                    const result = await executorRegistry.execute(jobName, payload as JobPayload<typeof jobName>, {
                        updateProgress: (p) => job.updateProgress(p as object | number),
                    });
                    const durationMs = Math.round(performance.now() - startTime);
                    if (!result.success) {
                        log.error(
                            { jobName, jobId: job.id, attemptsMade: job.attemptsMade, durationMs, errorMessage: result.errorMessage },
                            'job processing failed',
                        );
                        const message = result.errorMessage || `Job "${jobName}" failed`;
                        throw result.noRetry ? new UnrecoverableError(message) : new Error(message);
                    }
                    log.info({ jobName, jobId: job.id, durationMs, itemsActioned: result.itemsActioned }, 'job processed');
                    return result;
                },
            );
        },
        { connection: connection as unknown as ConnectionOptions, concurrency },
    );

    worker.on('completed', () => void beat(connection));
    worker.on('failed', (job, error) => {
        log.error({ jobName: job?.name, jobId: job?.id, error: safeErrorMeta(error) }, 'job failed');
    });
    worker.on('error', (error) => {
        log.error({ error: safeErrorMeta(error) }, 'worker error');
    });
    return worker;
}
