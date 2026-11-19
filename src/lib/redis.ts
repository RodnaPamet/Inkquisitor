/**
 * Redis connections (ioredis) — the shared client and fresh ones for BullMQ.
 *
 * URL resolution (`resolveRedisUrl`):
 *   - `REDIS_URL` when set;
 *   - otherwise, outside production, the compose stack's Redis
 *     (`DEV_REDIS_URL`), so `npm run dev` and the worker need no setting;
 *   - otherwise (production with no REDIS_URL) it THROWS. Production also
 *     refuses to start in that state (`src/lib/startup-checks.ts`); the throw
 *     is the backstop for a process that skipped the check.
 *
 * The shared client is cached on `globalThis` so a dev hot reload does not
 * open a new connection each time.
 *
 * Adapted from inflect-compliance's `src/lib/redis.ts` (its eviction-policy
 * probe is not carried; the compose file pins `noeviction`).
 */
import Redis from 'ioredis';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

export const DEV_REDIS_URL = 'redis://localhost:6379';

export function resolveRedisUrl(): string {
    if (env.REDIS_URL) return env.REDIS_URL;
    if (env.NODE_ENV === 'production') {
        throw new Error('REDIS_URL is required in production (rate limits and the job queue depend on it).');
    }
    return DEV_REDIS_URL;
}

/** The URL with its password masked, for a log line. */
export function redactRedisUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.password) parsed.password = '***';
        return parsed.toString();
    } catch {
        return 'redis://***';
    }
}

const globalForRedis = globalThis as unknown as { __inkquisitorRedis?: Redis };

/** The process's shared client, created on first call. */
export function getRedis(): Redis {
    if (!globalForRedis.__inkquisitorRedis) {
        const url = resolveRedisUrl();
        const client = createRedisClient(url, 'inkquisitor-app');
        client.on('error', (err) => {
            logger.error('Redis connection error', { component: 'redis', error: err instanceof Error ? err.message : String(err) });
        });
        globalForRedis.__inkquisitorRedis = client;
    }
    return globalForRedis.__inkquisitorRedis;
}

/**
 * A NEW client the caller owns (and must quit): BullMQ queues and workers
 * each want their own connection. `maxRetriesPerRequest: null` is what BullMQ
 * requires of a blocking connection.
 */
export function createRedisClient(url: string = resolveRedisUrl(), connectionName = 'inkquisitor-worker'): Redis {
    return new Redis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        connectTimeout: 10_000,
        connectionName,
        // Exponential backoff capped at 5 s.
        retryStrategy: (times: number) => Math.min(times * 50, 5_000),
    });
}

/**
 * A NEW client for a BullMQ PRODUCER (a Queue that only adds). BullMQ's
 * guidance is the opposite of a Worker's: fail fast rather than wait. With
 * the offline queue off and a bounded retry count, a command sent while the
 * connection is down is rejected instead of held until Redis returns, so an
 * HTTP request that enqueues during an outage fails instead of hanging. (The
 * wait for the FIRST connection is BullMQ's own and has no such switch: the
 * enqueue seam bounds it with a timeout.)
 */
export function createProducerRedisClient(url: string = resolveRedisUrl(), connectionName = 'inkquisitor-queue'): Redis {
    return new Redis(url, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        enableReadyCheck: true,
        connectTimeout: 10_000,
        connectionName,
        retryStrategy: (times: number) => Math.min(times * 50, 5_000),
    });
}

/**
 * A NEW client for a request-path lookup (the sign-in lockout): a command
 * fails within `commandTimeout` rather than waiting for Redis to come back, so
 * the caller can degrade instead of hanging a sign-in. Commands sent before
 * the first connection are queued (the offline queue is on), so the first
 * request after a boot does not fail spuriously.
 */
export function createRedisClientWithBoundedCommands(connectionName: string, url: string = resolveRedisUrl()): Redis {
    const client = new Redis(url, {
        maxRetriesPerRequest: 1,
        commandTimeout: 1_500,
        connectTimeout: 2_000,
        enableReadyCheck: true,
        connectionName,
        retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    });
    client.on('error', (err) => {
        logger.warn('Redis connection error', { component: 'redis', connectionName, error: err instanceof Error ? err.message : String(err) });
    });
    return client;
}

/**
 * Close a client this process owns, completely: nothing of it may keep the
 * event loop alive afterwards.
 *
 *   ready        QUIT, so the server sees a clean goodbye (falls back to a hard
 *                disconnect if QUIT fails).
 *   end          nothing: already closed.
 *   anything     else (connecting, reconnecting after a refusal, waiting for a
 *                lazy connect): a hard disconnect, which also cancels the
 *                pending reconnect.
 *
 * WHY NOT JUST `disconnect()` (issue #9). ioredis's connector answers
 * `disconnect()` by calling `end()` on its socket and arming a 2-second timer
 * that destroys the socket unless it emits `close` first. A socket that was
 * refused has ALREADY closed and will not close again, so that timer always
 * runs to the end: a process (or a Jest run) that has finished is held open
 * for two more seconds. When the socket is already gone, `close` is emitted
 * for it here, which is what the connector is waiting for; nothing else is
 * listening on a socket ioredis has finished with.
 */
export async function closeRedisClient(client: Redis): Promise<void> {
    if (client.status === 'end') return;
    if (client.status === 'ready') {
        try {
            await client.quit();
            return;
        } catch {
            // fall through to a hard disconnect
        }
    }
    const stream = (client as unknown as { stream?: { destroyed?: boolean; emit(event: 'close', hadError: boolean): boolean } }).stream;
    client.disconnect();
    if (stream?.destroyed) stream.emit('close', false);
}

/** Quit the shared client, if one was made. */
export async function disconnectRedis(): Promise<void> {
    const client = globalForRedis.__inkquisitorRedis;
    if (!client) return;
    globalForRedis.__inkquisitorRedis = undefined;
    await closeRedisClient(client);
}
