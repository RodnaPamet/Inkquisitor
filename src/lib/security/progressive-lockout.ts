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
 *
 * THE ATTEMPT IS COUNTED BEFORE THE VERIFY, IN ONE ATOMIC STEP. inflect (and
 * this module until the 0.H review) read the count, verified, and recorded a
 * failure afterwards: N concurrent guesses at nine failures all read nine and
 * all verified. `ProgressiveLockout.attempt` reserves the attempt in the
 * store's single atomic `reserve` (a Lua script on Redis and Upstash) and the
 * count that reservation returns gates the verify; a success clears it.
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
    /**
     * Failures counted against the identifier: when allowed, INCLUDING the
     * attempt just reserved (it counts as a failure until a success clears
     * it); when refused, the count that locks it.
     */
    failureCount: number;
}

/** What one atomic reservation found. */
export interface Reservation {
    /** True when the attempt was recorded and may verify; false when locked out (nothing recorded). */
    allowed: boolean;
    /** Attempts counted in the window BEFORE this one (after a lapsed lockout's reset). */
    priorCount: number;
    /** The newest counted attempt before this one (Unix ms), or null. */
    lastAt: number | null;
}

/**
 * Where attempts are counted. `reserve` is ONE atomic step — a Lua script on
 * Redis and Upstash, a synchronous body in memory — so two concurrent
 * attempts can never read the same count:
 *
 *   drop what fell out of `windowMs`;
 *   at `lockoutAtFailures` or more: refuse while `now` is inside `lockoutMs`
 *     of the newest attempt, recording nothing; once that has passed, forget
 *     them all;
 *   otherwise record this attempt and report how many came before it.
 */
export interface FailureWindowStore {
    readonly kind: 'memory' | 'redis' | 'upstash';
    reserve(key: string, now: number, policy: ProgressiveRateLimitPolicy): Promise<Reservation>;
    /** Forget every attempt for `key`. */
    clear(key: string): Promise<void>;
}

// ─── Stores ──────────────────────────────────────────────────────────

/** Swept on a caller's turn, never on a timer (tests/guards/no-module-scope-timers.test.ts). */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** At most this many attempts are kept per key; the policy never needs more than its lockout count. */
const MAX_KEPT = 100;
const KEY_PREFIX = 'inkq:lockout:';

/** How long a key may live: long enough for its window AND for a lockout it carries. */
const ttlMsOf = (policy: ProgressiveRateLimitPolicy) => Math.max(policy.windowMs, policy.lockoutMs);

export class MemoryFailureStore implements FailureWindowStore {
    readonly kind = 'memory' as const;
    private readonly entries = new Map<string, { at: number[]; ttlMs: number }>();
    private lastSweepAt = 0;

    /** Atomic because nothing in it awaits: the read and the write happen in one turn. */
    async reserve(key: string, now: number, policy: ProgressiveRateLimitPolicy): Promise<Reservation> {
        this.sweep(now);
        let at = (this.entries.get(key)?.at ?? []).filter((t) => t > now - policy.windowMs);
        let lastAt = at.length > 0 ? Math.max(...at) : null;
        if (at.length >= policy.lockoutAtFailures && lastAt !== null) {
            if (now < lastAt + policy.lockoutMs) {
                this.entries.set(key, { at, ttlMs: ttlMsOf(policy) });
                return { allowed: false, priorCount: at.length, lastAt };
            }
            at = [];
            lastAt = null;
        }
        const priorCount = at.length;
        at.push(now);
        this.entries.set(key, { at: at.slice(-MAX_KEPT), ttlMs: ttlMsOf(policy) });
        return { allowed: true, priorCount, lastAt };
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
            if (!entry.at.some((t) => t > now - entry.ttlMs)) this.entries.delete(key);
        }
    }
}

/**
 * The reservation as one Redis script: a sorted set per key (score = the
 * attempt's time, member = time plus a nonce). Redis runs a script with no
 * other command interleaved, which is the atomicity the count needs.
 *
 *   KEYS[1] the key; ARGV: now, window cutoff, lockoutAtFailures, lockoutMs,
 *   member, MAX_KEPT, ttl ms. Returns { allowed (1/0), priorCount, lastAt or -1 }.
 */
export const RESERVE_SCRIPT = `
local k = KEYS[1]
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', k, '-inf', ARGV[2])
local count = redis.call('ZCARD', k)
local last = -1
if count > 0 then
  last = tonumber(redis.call('ZRANGE', k, -1, -1, 'WITHSCORES')[2])
end
if count >= tonumber(ARGV[3]) then
  if now < last + tonumber(ARGV[4]) then
    return {0, count, last}
  end
  redis.call('DEL', k)
  count = 0
  last = -1
end
redis.call('ZADD', k, now, ARGV[5])
redis.call('ZREMRANGEBYRANK', k, 0, -(tonumber(ARGV[6]) + 1))
redis.call('PEXPIRE', k, ARGV[7])
return {1, count, last}
`;

function member(at: number): string {
    return `${at}:${Math.random().toString(36).slice(2, 10)}`;
}

function reserveArgs(now: number, policy: ProgressiveRateLimitPolicy): string[] {
    return [
        String(now),
        String(now - policy.windowMs),
        String(policy.lockoutAtFailures),
        String(policy.lockoutMs),
        member(now),
        String(MAX_KEPT),
        String(ttlMsOf(policy)),
    ];
}

/** `{ allowed, priorCount, lastAt }` from the script's reply. */
function reservationOf(reply: unknown): Reservation {
    if (!Array.isArray(reply) || reply.length !== 3) throw new Error('lockout script: unexpected reply');
    const [allowed, priorCount, lastAt] = reply.map(Number);
    if (![allowed, priorCount, lastAt].every(Number.isFinite)) throw new Error('lockout script: unexpected reply');
    return { allowed: allowed === 1, priorCount, lastAt: lastAt < 0 ? null : lastAt };
}

export class RedisFailureStore implements FailureWindowStore {
    readonly kind = 'redis' as const;
    constructor(private readonly redis: Redis) {}

    async reserve(key: string, now: number, policy: ProgressiveRateLimitPolicy): Promise<Reservation> {
        return reservationOf(await this.redis.eval(RESERVE_SCRIPT, 1, KEY_PREFIX + key, ...reserveArgs(now, policy)));
    }

    async clear(key: string): Promise<void> {
        await this.redis.del(KEY_PREFIX + key);
    }
}

/** The subset of the Upstash client this store uses: the same script, over REST. */
export interface UpstashLike {
    eval(script: string, keys: string[], args: string[]): Promise<unknown>;
    del(key: string): Promise<unknown>;
}

export class UpstashFailureStore implements FailureWindowStore {
    readonly kind = 'upstash' as const;
    constructor(private readonly redis: UpstashLike) {}

    async reserve(key: string, now: number, policy: ProgressiveRateLimitPolicy): Promise<Reservation> {
        return reservationOf(await this.redis.eval(RESERVE_SCRIPT, [KEY_PREFIX + key], reserveArgs(now, policy)));
    }

    async clear(key: string): Promise<void> {
        await this.redis.del(KEY_PREFIX + key);
    }
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

    /**
     * Reserve one attempt, BEFORE verifying: it is counted as a failure now,
     * atomically, and the count it was given decides whether it may verify
     * and how long it waits first. A success then `reset`s the count; a
     * failure has nothing left to record. Checking first and recording after
     * the verify let N concurrent attempts at nine failures all read nine and
     * all verify (Phase 0.H review).
     */
    async attempt(key: string): Promise<ProgressiveDecision> {
        const now = this.now();
        const r = await this.use((s) => s.reserve(key, now, this.policy));
        if (!r.allowed) {
            const lockoutEnd = (r.lastAt ?? now) + this.policy.lockoutMs;
            return {
                allowed: false,
                delayMs: 0,
                retryAfterSeconds: Math.max(1, Math.ceil((lockoutEnd - now) / 1000)),
                failureCount: r.priorCount,
            };
        }
        return { allowed: true, delayMs: pickDelayMs(r.priorCount, this.policy.tiers), retryAfterSeconds: 0, failureCount: r.priorCount + 1 };
    }

    /** Forget the attempts (after a successful verify). */
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
