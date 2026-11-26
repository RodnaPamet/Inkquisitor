/**
 * The BullMQ worker — a standalone process beside the Next.js server.
 *
 *   npm run worker          development, from source through tsx
 *   npm run build:worker    bundle to dist/worker.mjs for the image
 *   node dist/worker.mjs    production
 *
 * Boot order:
 *   1. refuse to start a production process whose configuration is missing
 *      something production requires (the web tier asks the same in
 *      src/instrumentation.ts; this process never loads that hook);
 *   1b. the encryption sentinel: the master key must round-trip a value
 *      (src/lib/security/encryption-sentinel.ts, Phase 0.3);
 *   2. OpenTelemetry (no-op unless OTEL_ENABLED=true), Sentry, the mailer;
 *   3. register the repeatable schedules (idempotent), so a running worker
 *      always implies its schedules exist;
 *   4. start the Worker (src/app-layer/jobs/worker.ts).
 * SIGTERM / SIGINT close the Worker (which waits for the active job), quit
 * the connections and drain OTel and Sentry, then exit.
 *
 * Adapted from inflect-compliance's `scripts/worker.ts`.
 */
import { Queue, type Worker, type ConnectionOptions } from 'bullmq';
import type Redis from 'ioredis';
import { enforceProductionConfig } from '../src/lib/startup-checks';
import { runEncryptionSentinel } from '../src/lib/security/encryption-sentinel';
import { createProcessLogger } from '../src/lib/observability/process-logger';
import { safeErrorMeta } from '../src/lib/observability/safe-error';
import { initTelemetry, shutdownTelemetry } from '../src/lib/observability/instrumentation';
import { initSentry, shutdownSentry } from '../src/lib/observability/sentry';
import { initMailerFromEnv } from '../src/lib/mailer';
import { closeRedisClient, createRedisClient, redactRedisUrl, resolveRedisUrl } from '../src/lib/redis';
import { abortRunningJobs } from '../src/app-layer/jobs/shutdown-signal';
import { registerSchedules } from '../src/app-layer/jobs/register-schedules';
import { createJobWorker } from '../src/app-layer/jobs/worker';
import { executorRegistry } from '../src/app-layer/jobs/executor-registry';
import { QUEUE_NAME } from '../src/app-layer/jobs/types';

enforceProductionConfig(process.env);
try {
    runEncryptionSentinel();
} catch (err) {
    process.stderr.write(`[startup] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
}

const log = createProcessLogger('worker');
let connection: Redis | undefined;
let worker: Worker | undefined;

async function bootstrap(): Promise<void> {
    await initTelemetry();
    await initSentry();
    initMailerFromEnv();

    const url = resolveRedisUrl();
    log.info({ queueName: QUEUE_NAME, redisUrl: redactRedisUrl(url), executors: executorRegistry.listRegistered() }, 'starting worker');

    // Its own connection, quit when done: BullMQ leaves a connection it was
    // handed open on close().
    const schedulerConnection = createRedisClient(url, 'inkquisitor-scheduler');
    const schedulerQueue = new Queue(QUEUE_NAME, { connection: schedulerConnection as unknown as ConnectionOptions });
    try {
        const count = await registerSchedules(schedulerQueue);
        log.info({ count }, 'repeatable schedules registered');
    } catch (err) {
        // Failure-soft: the worker must still come up to drain queued jobs.
        log.error({ error: safeErrorMeta(err) }, 'failed to register repeatable schedules');
    } finally {
        await schedulerQueue.close().catch(() => undefined);
        await closeRedisClient(schedulerConnection);
    }

    connection = createRedisClient(url, 'inkquisitor-worker');
    worker = createJobWorker({ connection, log });
    worker.on('ready', () => log.info({ queueName: QUEUE_NAME }, 'worker ready — listening for jobs'));
}

async function shutdown(signal: string): Promise<void> {
    log.info({ signal }, 'shutdown signal received — closing worker');
    try {
        // #57 item 6: a running ingestion or extraction stops at its next step (ABORTED, resumable) rather than holding its claim until it goes stale.
        abortRunningJobs();
        await worker?.close();
        if (connection) await closeRedisClient(connection);
        await shutdownTelemetry();
        await shutdownSentry();
        log.info('worker shut down gracefully');
        process.exit(0);
    } catch (error) {
        log.error({ error: safeErrorMeta(error) }, 'error during shutdown');
        process.exit(1);
    }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

bootstrap().catch((err) => {
    log.fatal({ error: safeErrorMeta(err) }, 'worker bootstrap failed');
    process.exit(1);
});
