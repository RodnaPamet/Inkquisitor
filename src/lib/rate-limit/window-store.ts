/**
 * The storage the two edge tiers (auth, read) count in: Upstash when it is
 * configured, an in-process fixed window when it is not.
 *
 * ── WHEN UPSTASH IS USED ─────────────────────────────────────────────
 *
 * Exactly when BOTH `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
 * are set and `RATE_LIMIT_MODE` is not `memory`. inflect-compliance
 * defaulted the mode to `upstash` and then fell back to memory when the
 * client could not be built; here the fall-back is the rule, decided from
 * the configuration in one predicate (`usesUpstash`), so a development
 * machine with no Upstash account gets working limits with no setting.
 * The memory store gives each process its own budget: with N instances the
 * effective ceiling is N times the preset, which is why production should
 * configure Upstash.
 *
 * ── NO TIMER ─────────────────────────────────────────────────────────
 *
 * Expired windows are swept on a caller's turn, at most once per
 * `SWEEP_INTERVAL_MS`, never by a module-scope `setInterval`: an interval
 * nothing clears keeps its module graph alive for the life of the process,
 * which under Jest's in-band runner is every test file that imported it
 * (inflect-compliance #4613). `tests/guards/no-module-scope-timers.test.ts`
 * holds the rule for all of `src/`.
 *
 * Both stores are fail-open by the callers' contract: a backend that throws
 * lets the request through and logs, because an Upstash outage must not take
 * sign-in down with it.
 */
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/env';

export interface WindowCheck {
    ok: boolean;
    limit: number;
    remaining: number;
    /** Unix-ms timestamp at which the window resets. */
    reset: number;
    /** Whole seconds until the window resets; 0 when allowed, 1+ when blocked. */
    retryAfter: number;
}

export interface WindowPolicy {
    limit: number;
    windowMs: number;
}

/** True when this process counts in Upstash rather than in memory. */
export function usesUpstash(): boolean {
    return env.RATE_LIMIT_MODE !== 'memory' && !!env.UPSTASH_REDIS_REST_URL && !!env.UPSTASH_REDIS_REST_TOKEN;
}

// ─── Memory ──────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 60 * 1000;

export class MemoryWindowStore {
    private readonly windows = new Map<string, { count: number; resetAt: number }>();
    private lastSweepAt = 0;

    constructor(private readonly now: () => number = Date.now) {}

    check(key: string, policy: WindowPolicy): WindowCheck {
        const now = this.now();
        this.sweep(now);
        let record = this.windows.get(key);
        if (!record || now >= record.resetAt) {
            record = { count: 0, resetAt: now + policy.windowMs };
        }
        record.count++;
        this.windows.set(key, record);
        const ok = record.count <= policy.limit;
        return {
            ok,
            limit: policy.limit,
            remaining: Math.max(0, policy.limit - record.count),
            reset: record.resetAt,
            retryAfter: ok ? 0 : Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
        };
    }

    /** Keys currently held; a test reads it to see the sweep. */
    get size(): number {
        return this.windows.size;
    }

    clear(): void {
        this.windows.clear();
        this.lastSweepAt = 0;
    }

    private sweep(now: number): void {
        if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
        this.lastSweepAt = now;
        for (const [key, record] of this.windows) {
            if (now >= record.resetAt) this.windows.delete(key);
        }
    }
}

// ─── Upstash ─────────────────────────────────────────────────────────

let redis: Redis | null = null;
const limiters = new Map<string, Ratelimit>();

/** A sliding-window Upstash limiter for one policy, built on first use. */
function upstashLimiter(prefix: string, policy: WindowPolicy): Ratelimit {
    const id = `${prefix}:${policy.limit}:${policy.windowMs}`;
    let limiter = limiters.get(id);
    if (!limiter) {
        redis ??= new Redis({ url: env.UPSTASH_REDIS_REST_URL!, token: env.UPSTASH_REDIS_REST_TOKEN! });
        limiter = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(policy.limit, `${policy.windowMs} ms`),
            prefix,
        });
        limiters.set(id, limiter);
    }
    return limiter;
}

/** Count one request against `key`, in whichever backend is configured. */
export async function checkWindow(
    store: MemoryWindowStore,
    prefix: string,
    key: string,
    policy: WindowPolicy,
): Promise<WindowCheck> {
    if (!usesUpstash()) return store.check(`${prefix}:${key}`, policy);
    const r = await upstashLimiter(prefix, policy).limit(key);
    return {
        ok: r.success,
        limit: r.limit,
        remaining: r.remaining,
        reset: r.reset,
        retryAfter: r.success ? 0 : Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)),
    };
}

/** The client IP an edge request names; a dev server sets none. */
export function edgeClientIp(headers: Headers): string {
    const forwarded = headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
    }
    return headers.get('x-real-ip')?.trim() || '127.0.0.1';
}

/** True when the edge tiers are switched off for this process. */
export function edgeRateLimitBypassed(): boolean {
    if (env.RATE_LIMIT_ENABLED === '0') return true;
    return env.NODE_ENV === 'test' && env.RATE_LIMIT_ENABLED !== '1';
}
