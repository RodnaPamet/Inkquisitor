/**
 * The progressive sign-in lockout counts in a store every process shares
 * (issue #10). Two `ProgressiveLockout` instances stand for two web
 * processes: over ONE store, failures recorded by either lock out both; over
 * a store each (the pre-0.H per-process Map), they do not — which is the
 * defect, shown here so the first half is not vacuous.
 *
 * The Redis store is exercised against a real Redis in
 * tests/integration/progressive-lockout-redis.test.ts.
 */
import {
    MemoryFailureStore,
    ProgressiveLockout,
    UpstashFailureStore,
    lockoutStoreKind,
    type FailureWindowStore,
    type UpstashLike,
} from '@/lib/security/progressive-lockout';
import { LOGIN_PROGRESSIVE_POLICY } from '@/lib/security/rate-limit';

const KEY = 'login-progressive:abc';
const LOCK_AT = LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures;

function clock(start = 1_000_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
}

async function failTimes(lockout: ProgressiveLockout, n: number) {
    for (let i = 0; i < n; i++) await lockout.recordFailure(KEY);
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
            const d = await process.evaluate(KEY);
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
        expect((await b.evaluate(KEY)).delayMs).toBe(5_000);
        await b.reset(KEY);
        expect(await a.evaluate(KEY)).toMatchObject({ allowed: true, delayMs: 0, failureCount: 0 });
    });

    it('a store per process (the old per-process Map) gives each its own budget', async () => {
        const c = clock();
        const a = new ProgressiveLockout(new MemoryFailureStore(), LOGIN_PROGRESSIVE_POLICY, c.now);
        const b = new ProgressiveLockout(new MemoryFailureStore(), LOGIN_PROGRESSIVE_POLICY, c.now);
        await failTimes(a, LOCK_AT);
        expect((await a.evaluate(KEY)).allowed).toBe(false);
        expect((await b.evaluate(KEY)).allowed).toBe(true);
    });
});

describe('the policy over a shared store', () => {
    it('delays, then locks for lockoutMs after the last failure, then resets to zero', async () => {
        const c = clock();
        const lockout = new ProgressiveLockout(new MemoryFailureStore(), LOGIN_PROGRESSIVE_POLICY, c.now);
        const delays: number[] = [];
        for (let i = 0; i < LOCK_AT; i++) {
            delays.push((await lockout.evaluate(KEY)).delayMs);
            await lockout.recordFailure(KEY);
        }
        expect(delays).toEqual([0, 0, 0, 5_000, 5_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
        c.advance(LOGIN_PROGRESSIVE_POLICY.lockoutMs - 1_000);
        expect((await lockout.evaluate(KEY)).allowed).toBe(false);
        c.advance(1_000);
        expect(await lockout.evaluate(KEY)).toMatchObject({ allowed: true, delayMs: 0, failureCount: 0 });
        // The reset is real: one more failure is the first again.
        expect((await lockout.recordFailure(KEY)).failureCount).toBe(1);
    });

    it('failures older than the window stop counting', async () => {
        const c = clock();
        const lockout = new ProgressiveLockout(new MemoryFailureStore(), LOGIN_PROGRESSIVE_POLICY, c.now);
        await failTimes(lockout, 4);
        c.advance(LOGIN_PROGRESSIVE_POLICY.windowMs + 1);
        expect((await lockout.evaluate(KEY)).failureCount).toBe(0);
    });
});

describe('a shared store that fails', () => {
    const broken: FailureWindowStore = {
        kind: 'redis',
        read: async () => {
            throw new Error('ECONNREFUSED');
        },
        append: async () => {
            throw new Error('ECONNREFUSED');
        },
        clear: async () => {
            throw new Error('ECONNREFUSED');
        },
    };

    it('degrades to this process’s memory: sign-in keeps working and the lockout still applies', async () => {
        const c = clock();
        const lockout = new ProgressiveLockout(broken, LOGIN_PROGRESSIVE_POLICY, c.now);
        expect((await lockout.evaluate(KEY)).allowed).toBe(true);
        await failTimes(lockout, LOCK_AT);
        expect((await lockout.evaluate(KEY)).allowed).toBe(false);
    });
});

/** A small in-memory stand-in for the Upstash REST client's sorted-set commands. */
function fakeUpstash(): UpstashLike {
    const sets = new Map<string, Array<{ score: number; member: string }>>();
    const bound = (v: number | string, open: boolean) => {
        if (v === '-inf') return -Infinity;
        if (v === '+inf') return Infinity;
        const s = String(v);
        return s.startsWith('(') ? { v: Number(s.slice(1)), open: true } : { v: Number(s), open };
    };
    const within = (score: number, lo: ReturnType<typeof bound>, hi: ReturnType<typeof bound>) => {
        const lower = typeof lo === 'number' ? score >= lo : lo.open ? score > lo.v : score >= lo.v;
        const upper = typeof hi === 'number' ? score <= hi : hi.open ? score < hi.v : score <= hi.v;
        return lower && upper;
    };
    return {
        async zadd(key, entry) {
            const set = sets.get(key) ?? [];
            set.push(entry);
            set.sort((x, y) => x.score - y.score);
            sets.set(key, set);
        },
        async zremrangebyscore(key, min, max) {
            const lo = bound(min, false);
            const hi = bound(max, false);
            sets.set(key, (sets.get(key) ?? []).filter((e) => !within(e.score, lo, hi)));
        },
        async zremrangebyrank(key, start, stop) {
            const set = sets.get(key) ?? [];
            const n = set.length;
            const from = start < 0 ? n + start : start;
            const to = stop < 0 ? n + stop : stop;
            sets.set(key, set.filter((_, i) => i < from || i > to));
        },
        async zrange(key, min, max) {
            const lo = bound(min, false);
            const hi = bound(max, false);
            return (sets.get(key) ?? []).filter((e) => within(e.score, lo, hi)).flatMap((e) => [e.member, e.score]);
        },
        async pexpire() {},
        async del(key) {
            sets.delete(key);
        },
    };
}

describe('the Upstash store', () => {
    it('two processes over one Upstash database share the lockout', async () => {
        const c = clock();
        const upstash = fakeUpstash();
        const a = new ProgressiveLockout(new UpstashFailureStore(upstash), LOGIN_PROGRESSIVE_POLICY, c.now);
        const b = new ProgressiveLockout(new UpstashFailureStore(upstash), LOGIN_PROGRESSIVE_POLICY, c.now);
        for (let i = 0; i < LOCK_AT; i++) {
            await (i % 2 ? a : b).recordFailure(KEY);
            c.advance(1);
        }
        expect((await a.evaluate(KEY)).allowed).toBe(false);
        expect((await b.evaluate(KEY)).allowed).toBe(false);
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
