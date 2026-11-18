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

/** Quit the shared client, if one was made. */
export async function disconnectRedis(): Promise<void> {
    const client = globalForRedis.__inkquisitorRedis;
    if (!client) return;
    globalForRedis.__inkquisitorRedis = undefined;
    await client.quit().catch(() => client.disconnect());
}
