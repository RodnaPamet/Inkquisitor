/**
 * The progressive sign-in lockout, counted in a store every process shares.
 *
 * `LOGIN_PROGRESSIVE_POLICY` (./rate-limit.ts) says what a run of failures
 * costs: a delay from the third, a longer one from the fifth, a 15-minute
 * lockout at the tenth. Until Phase 0.H the failures were counted in a Map in
 * each process, so with N web processes an attacker had N lockout budgets,
 * and a restart forgot every one (issue #10). The count now lives in a
 * `FailureWindowStore`:
 *
 *   Upstash configured (both UPSTASH_REDIS_REST_* set)  → Upstash (REST)
 *   otherwise, a production process                     → Redis (REDIS_URL,
 *                                                         which production requires)
 *   otherwise (development, test)                       → this process's memory
 *
 * `loginLockout()` makes that choice once per process. The store is the
 * existing rate-limit abstraction's backend (Upstash through
 * `src/lib/rate-limit/window-store.ts`, Redis through `src/lib/redis.ts`).
 *
 * A STORE THAT FAILS DEGRADES, IT DOES NOT OPEN. A Redis outage must not stop
 * people signing in, and must not switch the lockout off either: an error
 * from the shared store is logged and the attempt is counted in this
 * process's memory instead, which is exactly the pre-0.H behaviour.
 *
 * The decision logic is the one inflect-compliance's
 * `evaluateProgressiveRateLimit` carried (lifted in Phase 0.4), unchanged in
 * meaning: failures are counted over `windowMs`; at `lockoutAtFailures` the
 * identifier is refused until `lockoutMs` after the last failure; the first
 * attempt after that finds the count reset to zero.
 */
import type Redis from 'ioredis';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { closeRedisClient, createRedisClientWithBoundedCommands } from '@/lib/redis';
import { upstashRedis, usesUpstash } from '@/lib/rate-limit/window-store';
import type { ProgressiveRateLimitPolicy, ProgressiveRateLimitTier } from './rate-limit';

export interface ProgressiveDecision {
    /** False while the identifier is locked out: no verify is attempted. */
    allowed: boolean;
    /** How long the caller should wait before verifying (0 below the first tier). */
    delayMs: number;
    /** Seconds until the lockout ends (at least 1) when refused, else 0. */
    retryAfterSeconds: number;
    /** Failures currently counted against the identifier. */
    failureCount: number;
}

/**
 * Where failures are counted. Every method takes the policy window so a
 * store can expire what falls out of it; timestamps are Unix milliseconds.
 */
export interface FailureWindowStore {
    readonly kind: 'memory' | 'redis' | 'upstash';
    /** The failure timestamps inside the window ending at `now`, oldest first. */
    read(key: string, windowMs: number, now: number): Promise<number[]>;
    /** Record one failure at `at`. */
    append(key: string, at: number, windowMs: number): Promise<void>;
    /** Forget every failure for `key`. */
    clear(key: string): Promise<void>;
}

// ─── Stores ──────────────────────────────────────────────────────────

/** Swept on a caller's turn, never on a timer (tests/guards/no-module-scope-timers.test.ts). */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class MemoryFailureStore implements FailureWindowStore {
    readonly kind = 'memory' as const;
    private readonly entries = new Map<string, { at: number[]; windowMs: number }>();
    private lastSweepAt = 0;

    async read(key: string, windowMs: number, now: number): Promise<number[]> {
        this.sweep(now);
        const entry = this.entries.get(key);
        if (!entry) return [];
        entry.at = entry.at.filter((t) => t > now - windowMs);
        return [...entry.at];
    }

    async append(key: string, at: number, windowMs: number): Promise<void> {
        this.sweep(at);
        const entry = this.entries.get(key) ?? { at: [], windowMs };
        entry.windowMs = Math.max(entry.windowMs, windowMs);
        entry.at = entry.at.filter((t) => t > at - windowMs);
        entry.at.push(at);
        this.entries.set(key, entry);
    }

    async clear(key: string): Promise<void> {
        this.entries.delete(key);
    }

    /** Keys held; a test reads it to see the sweep. */
    get size(): number {
        return this.entries.size;
    }

    private sweep(now: number): void {
        if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
        this.lastSweepAt = now;
        for (const [key, entry] of this.entries) {
            if (!entry.at.some((t) => t > now - entry.windowMs)) this.entries.delete(key);
        }
    }
}

/** At most this many failures are kept per key; the policy never needs more than its lockout count. */
const MAX_KEPT = 100;
const KEY_PREFIX = 'inkq:lockout:';

/** A sorted set per key (score = member = the failure's time, plus a nonce). */
function member(at: number): string {
    return `${at}:${Math.random().toString(36).slice(2, 10)}`;
}

export class RedisFailureStore implements FailureWindowStore {
    readonly kind = 'redis' as const;
    constructor(private readonly redis: Redis) {}

    async read(key: string, windowMs: number, now: number): Promise<number[]> {
        const k = KEY_PREFIX + key;
        const [, scores] = await Promise.all([
            this.redis.zremrangebyscore(k, '-inf', now - windowMs),
            this.redis.zrangebyscore(k, `(${now - windowMs}`, '+inf', 'WITHSCORES'),
        ]);
        return scoresOf(scores);
    }

    async append(key: string, at: number, windowMs: number): Promise<void> {
        const k = KEY_PREFIX + key;
        await this.redis
            .multi()
            .zadd(k, at, member(at))
            .zremrangebyscore(k, '-inf', at - windowMs)
            .zremrangebyrank(k, 0, -(MAX_KEPT + 1))
            .pexpire(k, windowMs)
            .exec();
    }

    async clear(key: string): Promise<void> {
        await this.redis.del(KEY_PREFIX + key);
    }
}

/** The subset of the Upstash client this store uses. */
export interface UpstashLike {
    zadd(key: string, entry: { score: number; member: string }): Promise<unknown>;
    zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
    zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>;
    zrange(key: string, min: number | string, max: number | string, opts: { byScore: true; withScores: true }): Promise<unknown[]>;
    pexpire(key: string, ms: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
}

export class UpstashFailureStore implements FailureWindowStore {
    readonly kind = 'upstash' as const;
    constructor(private readonly redis: UpstashLike) {}

    async read(key: string, windowMs: number, now: number): Promise<number[]> {
        const k = KEY_PREFIX + key;
        await this.redis.zremrangebyscore(k, '-inf', now - windowMs);
        return scoresOf(await this.redis.zrange(k, `(${now - windowMs}`, '+inf', { byScore: true, withScores: true }));
    }

    async append(key: string, at: number, windowMs: number): Promise<void> {
        const k = KEY_PREFIX + key;
        await this.redis.zadd(k, { score: at, member: member(at) });
        await this.redis.zremrangebyscore(k, '-inf', at - windowMs);
        await this.redis.zremrangebyrank(k, 0, -(MAX_KEPT + 1));
        await this.redis.pexpire(k, windowMs);
    }

    async clear(key: string): Promise<void> {
        await this.redis.del(KEY_PREFIX + key);
    }
}

/** `[member, score, member, score, …]` → the scores, ascending. */
function scoresOf(flat: readonly unknown[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < flat.length; i += 2) {
        const n = Number(flat[i]);
        if (Number.isFinite(n)) out.push(n);
    }
    return out.sort((a, b) => a - b);
}

// ─── The lockout ─────────────────────────────────────────────────────

function pickDelayMs(count: number, tiers: readonly ProgressiveRateLimitTier[]): number {
    let delay = 0;
    for (const tier of tiers) if (count >= tier.atFailures) delay = tier.delayMs;
    return delay;
}

export class ProgressiveLockout {
    private readonly fallback = new MemoryFailureStore();

    constructor(
        private readonly store: FailureWindowStore,
        private readonly policy: ProgressiveRateLimitPolicy,
        private readonly now: () => number = () => Date.now(),
    ) {}

    get storeKind(): FailureWindowStore['kind'] {
        return this.store.kind;
    }

    /** The decision for the next attempt, recording nothing. Call BEFORE verifying. */
    async evaluate(key: string): Promise<ProgressiveDecision> {
        const now = this.now();
        const failures = await this.use((s) => s.read(key, this.policy.windowMs, now));
        const failureCount = failures.length;
        if (failureCount >= this.policy.lockoutAtFailures) {
            const lockoutEnd = failures[failures.length - 1] + this.policy.lockoutMs;
            if (now < lockoutEnd) {
                return {
                    allowed: false,
                    delayMs: 0,
                    retryAfterSeconds: Math.max(1, Math.ceil((lockoutEnd - now) / 1000)),
                    failureCount,
                };
            }
            // The lockout is over: the count resets, and the attempt is free.
            await this.use((s) => s.clear(key));
            return { allowed: true, delayMs: 0, retryAfterSeconds: 0, failureCount: 0 };
        }
        return { allowed: true, delayMs: pickDelayMs(failureCount, this.policy.tiers), retryAfterSeconds: 0, failureCount };
    }

    /** Record a failure (AFTER a verify said no); returns the decision that now stands. */
    async recordFailure(key: string): Promise<ProgressiveDecision> {
        const now = this.now();
        await this.use((s) => s.append(key, now, this.policy.windowMs));
        return this.evaluate(key);
    }

    /** Forget the failures (after a successful verify). */
    async reset(key: string): Promise<void> {
        await this.use((s) => s.clear(key));
    }

    /** Run on the shared store; on its failure, log and run on this process's memory. */
    private async use<T>(op: (store: FailureWindowStore) => Promise<T>): Promise<T> {
        if (this.store.kind === 'memory') return op(this.store);
        try {
            return await op(this.store);
        } catch (err) {
            logger.warn('auth.lockout_store_unavailable', {
                component: 'auth',
                store: this.store.kind,
                errorName: err instanceof Error ? err.name : 'unknown',
            });
            return op(this.fallback);
        }
    }
}

// ─── The process's lockout ───────────────────────────────────────────

/** Which store this process's configuration selects (see the header). */
export function lockoutStoreKind(): FailureWindowStore['kind'] {
    if (usesUpstash()) return 'upstash';
    if (env.NODE_ENV === 'production') return 'redis';
    return 'memory';
}

let lockoutRedis: Redis | null = null;

function buildStore(kind: FailureWindowStore['kind']): FailureWindowStore {
    if (kind === 'upstash') return new UpstashFailureStore(upstashRedis() as unknown as UpstashLike);
    if (kind === 'redis') {
        lockoutRedis ??= createRedisClientWithBoundedCommands('inkquisitor-lockout');
        return new RedisFailureStore(lockoutRedis);
    }
    return new MemoryFailureStore();
}

const lockouts = new Map<string, ProgressiveLockout>();

/** The lockout for `policy` in this process, over the store the configuration selects. */
export function lockoutFor(policy: ProgressiveRateLimitPolicy): ProgressiveLockout {
    const kind = lockoutStoreKind();
    const id = `${kind}:${policy.lockoutAtFailures}:${policy.lockoutMs}:${policy.windowMs}`;
    let lockout = lockouts.get(id);
    if (!lockout) {
        lockout = new ProgressiveLockout(buildStore(kind), policy);
        lockouts.set(id, lockout);
    }
    return lockout;
}

/** @internal test-only: forget every lockout (and its memory) this process holds. */
export async function _resetLockouts(): Promise<void> {
    lockouts.clear();
    const client = lockoutRedis;
    lockoutRedis = null;
    if (client) await closeRedisClient(client);
}
