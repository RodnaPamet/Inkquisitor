/**
 * Job queue — the typed BullMQ enqueue seam.
 *
 *   await enqueue('heartbeat', { enqueuedAt: new Date().toISOString() });
 *
 * One Queue per process (cached on `globalThis`, so HMR does not leak
 * connections), on its own Redis connection. `enqueue` applies the job's
 * `JOB_DEFAULTS`, wraps the add in an `enqueue <name>` span and injects the
 * W3C trace context into the payload, so the worker's execute span is the
 * enqueue span's child.
 *
 * `getQueue(queueName)` takes a name so an integration test can work on a
 * queue of its own; application code always uses `QUEUE_NAME`.
 *
 * FAILS FAST when Redis is down. The producer connection has no offline queue
 * (`createProducerRedisClient`), and the add is bounded by
 * `ENQUEUE_TIMEOUT_MS`, because BullMQ waits for its first connection with no
 * limit of its own: without the bound, a route handler that enqueued during
 * an outage hung its HTTP request for as long as the outage lasted. A timeout
 * is an `externalServiceError` (502). An add that completes after its timeout
 * still lands, so a job a caller retries may run twice: executors are
 * idempotent on the rows their payload names.
 *
 * Adapted from inflect-compliance's `src/app-layer/jobs/queue.ts`.
 */
import { Queue, type JobsOptions, type ConnectionOptions } from 'bullmq';
import type Redis from 'ioredis';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { closeRedisClient, createProducerRedisClient } from '@/lib/redis';
import { externalServiceError } from '@/lib/errors/types';
import { captureTraceCarrier, OTEL_CARRIER_KEY } from '@/lib/observability/job-trace';
import { logger } from '@/lib/observability/logger';
import { safeErrorMessage, toReportableError } from '@/lib/observability/safe-error';
import { QUEUE_NAME, JOB_DEFAULTS, type JobName, type JobPayload } from './types';

interface OpenQueue {
    queue: Queue;
    connection: Redis;
}

const globalForQueue = globalThis as unknown as { __inkquisitorQueues?: Map<string, OpenQueue> };

function queues(): Map<string, OpenQueue> {
    globalForQueue.__inkquisitorQueues ??= new Map();
    return globalForQueue.__inkquisitorQueues;
}

/**
 * BullMQ accepts a colon in a custom job id only when the id splits into
 * exactly three parts; anything else is refused at add time, every time.
 * Checked here, the one place every enqueue passes (inflect-compliance #3554:
 * a hand-built id was refused for seven days and nothing noticed).
 */
export function isValidBullMqJobId(jobId: string): boolean {
    return !jobId.includes(':') || jobId.split(':').length === 3;
}

export function getQueue(queueName: string = QUEUE_NAME): Queue {
    const existing = queues().get(queueName);
    if (existing) return existing.queue;
    const connection = createProducerRedisClient(undefined, 'inkquisitor-queue');
    const queue = new Queue(queueName, {
        // ioredis and bullmq each carry a copy of ioredis's types; the runtime
        // object is the same.
        connection: connection as unknown as ConnectionOptions,
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 500,
            removeOnFail: 1000,
        },
    });
    queue.on('error', (err) => {
        logger.warn('queue connection error', { component: 'queue', error: safeErrorMessage(err) });
    });
    queues().set(queueName, { queue, connection });
    return queue;
}

/** How long an enqueue waits for Redis before failing. */
export const ENQUEUE_TIMEOUT_MS = 5_000;

/** `promise`, or a rejection with an AppError once `ms` pass; the timer never holds the process. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(externalServiceError(`${what}: the job queue did not answer within ${ms} ms`)), ms);
        timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function enqueue<T extends JobName>(
    name: T,
    payload: JobPayload<T>,
    options?: Partial<JobsOptions> & { queueName?: string; timeoutMs?: number },
) {
    const { queueName, timeoutMs = ENQUEUE_TIMEOUT_MS, ...jobOptions } = options ?? {};
    if (jobOptions.jobId !== undefined && !isValidBullMqJobId(jobOptions.jobId)) {
        throw new Error(
            `enqueue(${name}): jobId "${jobOptions.jobId}" is not a valid BullMQ custom id ` +
                '(a colon is accepted only when the id splits into exactly three parts).',
        );
    }
    const queue = getQueue(queueName);
    const defaults = JOB_DEFAULTS[name];

    return trace.getTracer('inkquisitor.jobs').startActiveSpan(
        `enqueue ${name}`,
        {
            attributes: {
                'job.name': name,
                'messaging.system': 'bullmq',
                'messaging.destination.name': queue.name,
                'messaging.operation': 'publish',
            },
        },
        async (span) => {
            try {
                const job = await withTimeout(
                    queue.add(name, { ...payload, [OTEL_CARRIER_KEY]: captureTraceCarrier() }, { ...defaults, ...jobOptions }),
                    timeoutMs,
                    `enqueue(${name})`,
                );
                span.setAttribute('job.id', job.id ?? 'unknown');
                span.setStatus({ code: SpanStatusCode.OK });
                logger.info('job enqueued', { component: 'queue', jobName: name, jobId: job.id });
                return job;
            } catch (err) {
                span.recordException(toReportableError(err));
                span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorMessage(err) });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

/** Close every queue this process opened, and their connections. */
export async function closeQueue(): Promise<void> {
    const all = [...queues().values()];
    queues().clear();
    for (const { queue, connection } of all) {
        await queue.close().catch(() => undefined);
        // BullMQ leaves a connection it was handed open; it is ours to close,
        // completely, whatever state an outage left it in (issue #9).
        await closeRedisClient(connection);
    }
    if (all.length > 0) logger.info('job queue closed', { component: 'queue' });
}
