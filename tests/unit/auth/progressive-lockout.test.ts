/**
 * The progressive sign-in lockout counts in a store every process shares
 * (issue #10). Two `ProgressiveLockout` instances stand for two web
 * processes: over ONE store, failures recorded by either lock out both; over
 * a store each (the pre-0.H per-process Map), they do not — which is the
 * defect, shown here so the first half is not vacuous.
 *
 * Each attempt is RESERVED before its verify, in one atomic step whose count
 * gates it (Phase 0.H review): concurrent attempts at nine failures cannot all
 * read nine.
 *
 * The Redis and Upstash stores run the same Lua script; both are exercised
 * against a real Redis in tests/integration/progressive-lockout-redis.test.ts.
 */
import {
    MemoryFailureStore,
    ProgressiveLockout,
    lockoutStoreKind,
    type FailureWindowStore,
} from '@/lib/security/progressive-lockout';
import { LOGIN_PROGRESSIVE_POLICY } from '@/lib/security/rate-limit';

const KEY = 'login-progressive:abc';
const LOCK_AT = LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures;

function clock(start = 1_000_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** `n` attempts that each fail (an attempt is a failure until a success resets it). */
async function failTimes(lockout: ProgressiveLockout, n: number) {
    for (let i = 0; i < n; i++) await lockout.attempt(KEY);
}

describe('two processes over one store', () => {
    it('failures recorded by either lock out both', async () => {
        const c = clock();
        const store = new MemoryFailureStore();
        const a = new ProgressiveLockout(store, LOGIN_PROGRESSIVE_POLICY, c.now);
        const b = new ProgressiveLockout(store, LOGIN_PROGRESSIVE_POLICY, c.now);
        await failTimes(a, LOCK_AT / 2);
        await failTimes(b, LOCK_AT / 2);
        for (const process of [a, b]) {
            const d = await process.attempt(KEY);
            expect(d).toMatchObject({ allowed: false, failureCount: LOCK_AT });
            expect(d.retryAfterSeconds).toBeGreaterThan(14 * 60);
        }
    });

    it('a success in one resets the other', async () => {
        const c = clock();
        const store = new MemoryFailureStore();
        const a = new ProgressiveLockout(store, LOGIN_PROGRESSIVE_POLICY, c.now);
        const b = new ProgressiveLockout(store, LOGIN_PROGRESSIVE_POLICY, c.now);
        await failTimes(a, 4);
        expect((await b.attempt(KEY)).delayMs).toBe(5_000);
        await b.reset(KEY);
        expect(await a.attempt(KEY)).toMatchObject({ allowed: true, delayMs: 0, failureCount: 1 });
    });

    it('a store per process (the old per-process Map) gives each its own budget', async () => {
        const c = clock();
        const a = new ProgressiveLockout(new MemoryFailureStore(), LOGIN_PROGRESSIVE_POLICY, c.now);
        const b = new ProgressiveLockout(new MemoryFailureStore(), LOGIN_PROGRESSIVE_POLICY, c.now);
        await failTimes(a, LOCK_AT);
        expect((await a.attempt(KEY)).allowed).toBe(false);
        expect((await b.attempt(KEY)).allowed).toBe(true);
    });
});

describe('the policy over a shared store', () => {
    it('delays, then locks for lockoutMs after the last failure, then resets to zero', async () => {
        const c = clock();
        const lockout = new ProgressiveLockout(new MemoryFailureStore(), LOGIN_PROGRESSIVE_POLICY, c.now);
        const delays: number[] = [];
        for (let i = 0; i < LOCK_AT; i++) delays.push((await lockout.attempt(KEY)).delayMs);
        expect(delays).toEqual([0, 0, 0, 5_000, 5_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
        c.advance(LOGIN_PROGRESSIVE_POLICY.lockoutMs - 1_000);
        expect((await lockout.attempt(KEY)).allowed).toBe(false);
        // A refusal records nothing, so it does not extend the lockout.
        c.advance(1_000);
        // The reset is real: this attempt is the first again.
        expect(await lockout.attempt(KEY)).toMatchObject({ allowed: true, delayMs: 0, failureCount: 1 });
    });

    it('failures older than the window stop counting', async () => {
        const c = clock();
        const lockout = new ProgressiveLockout(new MemoryFailureStore(), LOGIN_PROGRESSIVE_POLICY, c.now);
        await failTimes(lockout, 4);
        c.advance(LOGIN_PROGRESSIVE_POLICY.windowMs + 1);
        expect((await lockout.attempt(KEY)).failureCount).toBe(1);
    });
});

describe('concurrent attempts are each counted before any verifies', () => {
    it('at nine failures, twenty concurrent attempts let exactly one through', async () => {
        const c = clock();
        const lockout = new ProgressiveLockout(new MemoryFailureStore(), LOGIN_PROGRESSIVE_POLICY, c.now);
        await failTimes(lockout, LOCK_AT - 1);
        const decisions = await Promise.all(Array.from({ length: 20 }, () => lockout.attempt(KEY)));
        expect(decisions.filter((d) => d.allowed)).toHaveLength(1);
    });

    it('from zero, forty concurrent attempts let exactly the lockout count through', async () => {
        const c = clock();
        const store = new MemoryFailureStore();
        const a = new ProgressiveLockout(store, LOGIN_PROGRESSIVE_POLICY, c.now);
        const b = new ProgressiveLockout(store, LOGIN_PROGRESSIVE_POLICY, c.now);
        const decisions = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).attempt(KEY)));
        expect(decisions.filter((d) => d.allowed)).toHaveLength(LOCK_AT);
        // Each was given its own count: 1..LOCK_AT, never the same one twice.
        expect(decisions.filter((d) => d.allowed).map((d) => d.failureCount).sort((x, y) => x - y)).toEqual(
            Array.from({ length: LOCK_AT }, (_, i) => i + 1),
        );
    });
});

describe('a shared store that fails', () => {
    const broken: FailureWindowStore = {
        kind: 'redis',
        reserve: async () => {
            throw new Error('ECONNREFUSED');
        },
        clear: async () => {
            throw new Error('ECONNREFUSED');
        },
    };

    it('degrades to this process’s memory: sign-in keeps working and the lockout still applies', async () => {
        const c = clock();
        const lockout = new ProgressiveLockout(broken, LOGIN_PROGRESSIVE_POLICY, c.now);
        expect((await lockout.attempt(KEY)).allowed).toBe(true);
        await failTimes(lockout, LOCK_AT - 1);
        expect((await lockout.attempt(KEY)).allowed).toBe(false);
    });
});

describe('which store the configuration selects', () => {
    const env = process.env as Record<string, string | undefined>;
    afterEach(() => {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        env.NODE_ENV = 'test';
    });

    it('memory in development and test, Redis in production, Upstash whenever it is configured', () => {
        expect(lockoutStoreKind()).toBe('memory');
        env.NODE_ENV = 'development';
        expect(lockoutStoreKind()).toBe('memory');
        env.NODE_ENV = 'production';
        expect(lockoutStoreKind()).toBe('redis');
        process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'not-a-token';
        expect(lockoutStoreKind()).toBe('upstash');
        env.NODE_ENV = 'test';
        expect(lockoutStoreKind()).toBe('upstash');
    });
});
