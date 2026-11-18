/**
 * In-Memory Rate Limiter
 *
 * Lifted from inflect-compliance's `src/lib/security/rate-limit.ts` (see
 * docs/carve-manifest.md); the presets are cut to the product-neutral ones.
 * The history below is that repository's.
 *
 * Simple sliding-window rate limiter for brute-force protection.
 * Uses a Map to track attempt timestamps per key (IP, userId, etc.).
 *
 * DESIGN: In-memory is appropriate for single-instance deployments.
 * For multi-instance, swap to Redis-backed limiter.
 *
 * This module is intentionally simple and dependency-free.
 *
 * ── NO TIMER, AND WHY (#4613) ──────────────────────────────────────────
 *
 * Stale keys are swept on a caller's turn, at most once per
 * `SWEEP_INTERVAL_MS`, instead of by a module-level `setInterval`. An
 * interval that is never cleared holds its callback, and the callback holds
 * this module's scope, for the life of the process. In a server that is one
 * module and harmless. Under Jest's in-band runner every test file loads its
 * own copy of this module, so every file that touched the limiter left a
 * five-minute interval behind that kept that file's whole module graph alive
 * to the end of the shard. Heap snapshots of a shard 7/7 file run locally and
 * of shard 2/7 on CI both traced retained test contexts to
 * `TimersList[300000] → Timeout → _onTimeout → this module`.
 *
 * The sweep also judges each key by ITS OWN window. The interval swept every
 * key with the window of whichever caller started it, so a one-minute preset
 * that ran first trimmed a one-hour login-failure history to its last minute
 * every five minutes, and a lockout counted over an hour was forgotten in
 * five.
 */

interface RateLimitEntry {
    timestamps: number[];
    /** The longest window this key has been counted over. A key is stale once nothing is inside it. */
    windowMs: number;
}

const store = new Map<string, RateLimitEntry>();

/** How often a caller's turn may also sweep stale keys. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

/**
 * Drop every key with no attempt inside its own window, at most once per
 * `SWEEP_INTERVAL_MS`. Only whole keys go: a timestamp inside its key's window
 * is never touched here, so no decision can differ from one made without the
 * sweep — every check filters to its own window first.
 */
function sweepStale(now: number): void {
    if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = now;
    for (const [key, entry] of store) {
        if (!entry.timestamps.some((t) => now - t < entry.windowMs)) store.delete(key);
    }
}

/** The key's entry, its window widened to `windowMs` if that is longer. */
function entryFor(key: string, windowMs: number): RateLimitEntry {
    const entry = store.get(key) ?? { timestamps: [], windowMs };
    if (windowMs > entry.windowMs) entry.windowMs = windowMs;
    return entry;
}

export interface RateLimitConfig {
    /** Maximum number of requests allowed in the window */
    maxAttempts: number;
    /** Window duration in milliseconds */
    windowMs: number;
    /** Optional: lockout duration in ms after max attempts exceeded */
    lockoutMs?: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
}

/**
 * Check if a request is within rate limits.
 *
 * `units` charges several attempts at once, ALL OR NOTHING: either every unit
 * fits in the window and all are recorded, or none is and the request is
 * refused with the budget untouched. With the default of 1 this is the
 * single-attempt check.
 *
 * @param key - Unique identifier (e.g., `login:${ip}`, `export:${userId}`)
 * @param config - Rate limit configuration
 * @param units - Attempts this request costs (default 1)
 * @returns Whether the request is allowed and how many attempts remain
 */
export function checkRateLimit(
    key: string,
    config: RateLimitConfig,
    units = 1,
): RateLimitResult {
    const now = Date.now();
    sweepStale(now);
    const entry = entryFor(key, config.windowMs);

    // Remove timestamps outside the window
    const windowStart = now - config.windowMs;
    entry.timestamps = entry.timestamps.filter(t => t > windowStart);

    // Check lockout: if last attempt was within lockout period and at max
    if (config.lockoutMs && entry.timestamps.length >= config.maxAttempts) {
        const lastAttempt = entry.timestamps[entry.timestamps.length - 1];
        const lockoutEnd = lastAttempt + config.lockoutMs;
        if (now < lockoutEnd) {
            return {
                allowed: false,
                remaining: 0,
                retryAfterMs: lockoutEnd - now,
            };
        }
        // Lockout expired, reset
        entry.timestamps = [];
    }

    if (entry.timestamps.length + units > config.maxAttempts) {
        store.set(key, entry);
        // The request fits once enough of the oldest attempts have left the
        // window to make room for all `units`. For one unit that is the oldest
        // attempt, as it always was. A charge larger than the whole budget can
        // never fit; callers bound that before asking, and the window is the
        // honest answer here.
        const freeingIndex = entry.timestamps.length + units - config.maxAttempts - 1;
        const freeingAt = entry.timestamps[Math.max(0, freeingIndex)];
        return {
            allowed: false,
            remaining: Math.max(0, config.maxAttempts - entry.timestamps.length),
            retryAfterMs:
                units > config.maxAttempts || freeingAt === undefined
                    ? config.windowMs
                    : freeingAt + config.windowMs - now,
        };
    }

    // Record this attempt — every unit of it.
    for (let i = 0; i < units; i += 1) entry.timestamps.push(now);
    store.set(key, entry);

    return {
        allowed: true,
        remaining: config.maxAttempts - entry.timestamps.length,
        retryAfterMs: 0,
    };
}

/**
 * Reset rate limit for a key (e.g., after successful auth).
 */
export function resetRateLimit(key: string): void {
    store.delete(key);
}

/**
 * For testing: clear all rate limit state.
 */
export function clearAllRateLimits(): void {
    store.clear();
    lastSweepAt = 0;
}

/** For testing: how many keys the limiter is holding, so a test can see the sweep. */
export function rateLimitKeyCount(): number {
    return store.size;
}

// ─── Preset Configurations ──────────────────────────────────────────
//
// Each preset encodes a policy choice. The numbers are not arbitrary —
// they balance user ergonomics against abuse resistance. Sizing rule
// of thumb:
//
//   sensitive auth flow   → small window, small budget, lockout
//   normal mutation       → per-minute window, moderate budget
//   highly privileged op  → hour window, tiny budget
//
// When you add a new preset, document the threat model in the JSDoc
// and prefer tighter-than-you-think limits — the middleware returns
// a clean 429 + Retry-After, not an opaque error.

/**
 * Login (credentials sign-in, password reset — Phase 0.3's routes):
 *   10 attempts per 15 minutes, 15 min lockout after exhaustion.
 *
 * Threat model: online password brute-force. The lockout doubles as
 * a back-pressure signal — an attacker spraying credentials across
 * thousands of accounts gets degraded throughput per IP even when
 * they rotate usernames, because the middleware keys by IP+userId
 * when available but falls back to IP alone for pre-authentication.
 */
export const LOGIN_LIMIT: RateLimitConfig = {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
    lockoutMs: 15 * 60 * 1000,
};

/**
 * General mutation API: 60 requests per minute per (IP, userId).
 *
 * Threat model: a compromised credential or a runaway client making
 * thousands of writes per second. The limit is intentionally
 * generous — normal interactive use doesn't come close (a user
 * filling a detail form might submit 2-3 writes per minute). A local
 * load test turns the limiter off with RATE_LIMIT_ENABLED=0 (it is
 * already off under Jest); there is no higher-budget credential to
 * reach for.
 */
export const API_MUTATION_LIMIT: RateLimitConfig = {
    maxAttempts: 60,
    windowMs: 60 * 1000,
};

/**
 * General read API: 120 requests per minute per (IP, userId, workspace).
 *
 * Applied at the Edge middleware to GET requests under `/api/`, excluding the
 * health probes (`/api/health`, `/api/livez`, `/api/readyz`) and the auth
 * tier's `/api/auth/` (see `src/lib/rate-limit/apiReadRateLimit.ts`).
 *
 * Threat model: scraping and accidental overload — a runaway client fanning
 * out list calls, or a stolen session reading a whole bible. Roughly twice the
 * mutation budget because reads are cheaper and a page load can fan out to
 * several endpoints. This preset is the single source of truth for the
 * numbers; the enforcement module reads them.
 */
export const API_READ_LIMIT: RateLimitConfig = {
    maxAttempts: 120,
    windowMs: 60 * 1000,
};

/**
 * Passwordless / magic-link email dispatch: 5 per hour per IP.
 *
 * Threat model: email bomb abuse (attacker pointing the "send link"
 * endpoint at a victim email). This preset is explicitly IP-only
 * even when the endpoint receives a target email — the rate applies
 * to senders, not recipients.
 */
export const EMAIL_DISPATCH_LIMIT: RateLimitConfig = {
    maxAttempts: 5,
    windowMs: 60 * 60 * 1000,
};

// ═══════════════════════════════════════════════════════════════════
// Progressive rate limit — Epic A.3 auth brute-force protection
// ═══════════════════════════════════════════════════════════════════
//
// The simple `RateLimitConfig` above is "N attempts per window,
// optional lockout" — a single threshold. Epic A.3 needs graduated
// *punishment*: each failed attempt past a threshold costs the
// attacker more wall-clock time, culminating in a hard lockout.
//
// The primitive is shared (not login-specific) so future flows
// (second-factor, recovery codes) can reuse it with their own policy.

export interface ProgressiveRateLimitTier {
    /** Apply this delay when cumulative failures >= this count. */
    atFailures: number;
    /** Milliseconds to delay the CURRENT attempt before verifying. */
    delayMs: number;
}

export interface ProgressiveRateLimitPolicy {
    /**
     * Tiers sorted ascending by `atFailures`. The highest-matching
     * tier's `delayMs` is applied; tiers do not sum. Failures below
     * the first tier's threshold incur no delay.
     */
    tiers: readonly ProgressiveRateLimitTier[];
    /** Failure count that flips the account into lockout. */
    lockoutAtFailures: number;
    /** Duration of the lockout once triggered. */
    lockoutMs: number;
    /**
     * Rolling window over which failures accumulate. A single entry
     * older than `windowMs` stops contributing to the count. Sized
     * generously — lockouts are meant to feel real, not rotate out.
     */
    windowMs: number;
}

/**
 * Epic A.3 login policy.
 *
 *   attempts 1-2  → no delay (typo allowance)
 *   attempts 3-4  → 5s delay (mild friction)
 *   attempts 5-9  → 30s delay (significant friction)
 *   attempt 10+   → 15 min lockout (attack territory)
 *
 * Failures are counted over a 1-hour window, so ten wrong passwords
 * spread over a day never lock anyone out. The lockout itself lasts
 * `lockoutMs` (15 minutes) from the last failure, NOT the rest of the
 * window: the first attempt after it ends finds the counter RESET to
 * zero (`evaluateProgressiveRateLimit`). So this policy alone admits
 * about 10 guesses per 15 minutes per identifier, roughly 40 an hour —
 * size brute-force exposure from that figure, not from 10/hour.
 */
export const LOGIN_PROGRESSIVE_POLICY: ProgressiveRateLimitPolicy = {
    tiers: [
        { atFailures: 3, delayMs: 5_000 },
        { atFailures: 5, delayMs: 30_000 },
    ],
    lockoutAtFailures: 10,
    lockoutMs: 15 * 60 * 1000,
    windowMs: 60 * 60 * 1000,
};

export interface ProgressiveRateLimitDecision {
    /**
     * `false` when the identifier is in lockout and no further
     * verify should be attempted. The caller returns 429/"too many
     * requests" to the client.
     */
    allowed: boolean;
    /**
     * Delay (ms) the caller SHOULD sleep before proceeding with the
     * expensive verify. `0` when under the first tier. The caller
     * is responsible for actually sleeping — this function returns
     * synchronously so it can be used inside timing-sensitive
     * branches (e.g. a dummyVerify needs to happen even on lockout).
     */
    delayMs: number;
    /**
     * Only populated when `allowed === false`. Seconds until the
     * lockout expires (always ≥ 1).
     */
    retryAfterSeconds: number;
    /** Failures currently counted against this identifier. */
    failureCount: number;
}

function pickDelayMs(
    count: number,
    tiers: readonly ProgressiveRateLimitTier[],
): number {
    let delay = 0;
    for (const tier of tiers) {
        if (count >= tier.atFailures) delay = tier.delayMs;
    }
    return delay;
}

/**
 * Evaluate the current state WITHOUT recording a new attempt. Call
 * this BEFORE verifying the password so the caller knows how long
 * to delay (and whether to short-circuit with a lockout response).
 *
 * Reuses the same sliding-window store the other rate-limit functions
 * in this file already use — one process-wide Map, swept on a caller's
 * turn (see the header).
 */
export function evaluateProgressiveRateLimit(
    key: string,
    policy: ProgressiveRateLimitPolicy,
): ProgressiveRateLimitDecision {
    const now = Date.now();
    sweepStale(now);
    const entry = entryFor(key, policy.windowMs);

    // Expire stale failures out of the count but keep the entry
    // stored; caller may be about to write a new failure.
    const windowStart = now - policy.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    store.set(key, entry);

    const failureCount = entry.timestamps.length;

    if (failureCount >= policy.lockoutAtFailures) {
        const lastFailure = entry.timestamps[entry.timestamps.length - 1];
        const lockoutEnd = lastFailure + policy.lockoutMs;
        if (now < lockoutEnd) {
            return {
                allowed: false,
                delayMs: 0,
                retryAfterSeconds: Math.max(
                    1,
                    Math.ceil((lockoutEnd - now) / 1000),
                ),
                failureCount,
            };
        }
        // Lockout expired — counter resets. The attempt proceeds
        // with zero delay; a legitimate user who came back after
        // the lockout should not immediately eat another 30s.
        entry.timestamps = [];
        store.set(key, entry);
        return {
            allowed: true,
            delayMs: 0,
            retryAfterSeconds: 0,
            failureCount: 0,
        };
    }

    return {
        allowed: true,
        delayMs: pickDelayMs(failureCount, policy.tiers),
        retryAfterSeconds: 0,
        failureCount,
    };
}

/**
 * Record a failure for this identifier. Call AFTER a verify has
 * returned `false`. Returns the post-increment decision so the
 * caller can surface the new lockout state to logging / audit.
 */
export function recordProgressiveFailure(
    key: string,
    policy: ProgressiveRateLimitPolicy,
): ProgressiveRateLimitDecision {
    const now = Date.now();
    sweepStale(now);
    const entry = entryFor(key, policy.windowMs);
    // Trim the window before writing so the count we return is
    // current.
    const windowStart = now - policy.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    entry.timestamps.push(now);
    store.set(key, entry);

    return evaluateProgressiveRateLimit(key, policy);
}

/**
 * Clear the failure list. Call after a SUCCESSFUL verify so a
 * legitimate user who typo'd a few times isn't still throttled on
 * the next login.
 */
export function resetProgressiveFailures(key: string): void {
    store.delete(key);
}
