/**
 * Readiness — are the dependencies a request needs reachable right now?
 *
 * `GET /api/readyz` answers 200 only when EVERY check passes and 503 naming
 * the failed ones otherwise, so an orchestrator stops routing to an instance
 * that cannot serve. Two checks today: PostgreSQL (`SELECT 1`) and Redis
 * (`PING`). Each is raced against `CHECK_TIMEOUT_MS`, and the checks run in
 * parallel, so the probe answers in about that long even when a dependency
 * hangs rather than refuses.
 *
 * Error strings are a fixed vocabulary (`timeout`, `connection_failed`,
 * `unexpected_reply`), never the driver's message: a Postgres error can name
 * the host, port and role, and the probe is unauthenticated.
 *
 * `runReadinessChecks` takes its checks as arguments so the unit test can
 * drive every outcome; the route passes `defaultReadinessChecks()`.
 *
 * Adapted from inflect-compliance's `src/app/api/readyz/route.ts` (its S3
 * check is not carried: storage defaults to local disk).
 */
import Redis from 'ioredis';
import { prisma } from '@/lib/db';
import { closeRedisClient, resolveRedisUrl } from '@/lib/redis';

export const CHECK_TIMEOUT_MS = 2_000;

export interface CheckResult {
    status: 'ok' | 'error';
    latencyMs: number;
    error?: 'timeout' | 'connection_failed' | 'unexpected_reply';
}

export type ReadinessCheck = () => Promise<'ok' | 'unexpected_reply'>;

export interface ReadinessReport {
    ready: boolean;
    checks: Record<string, CheckResult>;
    failed: string[];
}

class CheckTimeout extends Error {}

async function runOne(check: ReadinessCheck, timeoutMs: number): Promise<CheckResult> {
    const start = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
        const outcome = await Promise.race([
            check(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new CheckTimeout()), timeoutMs);
            }),
        ]);
        return outcome === 'ok'
            ? { status: 'ok', latencyMs: Date.now() - start }
            : { status: 'error', latencyMs: Date.now() - start, error: 'unexpected_reply' };
    } catch (err) {
        return {
            status: 'error',
            latencyMs: Date.now() - start,
            error: err instanceof CheckTimeout ? 'timeout' : 'connection_failed',
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function runReadinessChecks(
    checks: Record<string, ReadinessCheck>,
    timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<ReadinessReport> {
    const names = Object.keys(checks);
    const results = await Promise.all(names.map((n) => runOne(checks[n], timeoutMs)));
    const out: Record<string, CheckResult> = {};
    names.forEach((n, i) => (out[n] = results[i]));
    const failed = names.filter((n) => out[n].status === 'error');
    // Zero checks is not "ready": a probe that checked nothing evidences nothing.
    return { ready: names.length > 0 && failed.length === 0, checks: out, failed };
}

// ─── The real checks ─────────────────────────────────────────────────

let probeRedis: Redis | null = null;

/**
 * A client of the probe's own, so a probe never waits behind the app's
 * traffic, and so its retries are bounded: one retry per command, then the
 * command fails, instead of queueing for as long as Redis is down.
 */
function readinessRedis(): Redis {
    probeRedis ??= new Redis(resolveRedisUrl(), {
        lazyConnect: true,
        connectTimeout: CHECK_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        connectionName: 'inkquisitor-readyz',
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
    });
    // An unreachable Redis is reported by the probe; the client must not also
    // throw an unhandled 'error' event.
    probeRedis.on('error', () => undefined);
    return probeRedis;
}

export function defaultReadinessChecks(): Record<string, ReadinessCheck> {
    return {
        database: async () => {
            await prisma.$queryRaw`SELECT 1`;
            return 'ok';
        },
        redis: async () => {
            const client = readinessRedis();
            if (client.status === 'wait') await client.connect();
            return (await client.ping()) === 'PONG' ? 'ok' : 'unexpected_reply';
        },
    };
}

/** Close the probe's client completely (tests; graceful shutdown). */
export async function _closeReadinessClients(): Promise<void> {
    const client = probeRedis;
    probeRedis = null;
    if (client) await closeRedisClient(client);
}
