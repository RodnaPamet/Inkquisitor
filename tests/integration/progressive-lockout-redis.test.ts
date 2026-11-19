/**
 * The sign-in lockout over a real Redis, as production counts it (issue #10).
 *
 * Two `ProgressiveLockout` instances, each on its OWN Redis connection, stand
 * for two web processes. Failures recorded through either lock out both, a
 * success through either resets both, and the decision survives a
 * "restart" (a fresh instance and connection over the same data).
 *
 * The reservation is ONE Lua script (`RESERVE_SCRIPT`), so concurrent
 * attempts from both connections are each given their own count and at most
 * the lockout count verify (Phase 0.H review). The Upstash store sends the
 * same script over REST; here it is driven through an adapter onto the real
 * Redis, so its key and argument mapping run against real Lua too.
 *
 * Logical database 14 and keys of this run's own (tests/helpers/test-redis.ts).
 */
import Redis from 'ioredis';
import {
    ProgressiveLockout,
    RedisFailureStore,
    UpstashFailureStore,
    type FailureWindowStore,
    type UpstashLike,
} from '@/lib/security/progressive-lockout';
import { LOGIN_PROGRESSIVE_POLICY } from '@/lib/security/rate-limit';
import { closeRedisClient } from '@/lib/redis';
import { testRedisUrl } from '../helpers/test-redis';

const RUN = `it-${process.pid}-${Date.now()}`;
const LOCK_AT = LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures;
const clients: Redis[] = [];
const keys: string[] = [];

function freshKey(name: string): string {
    const key = `login-progressive:${RUN}:${name}`;
    keys.push(key);
    return key;
}

function connection(): Redis {
    const client = new Redis(testRedisUrl(), { maxRetriesPerRequest: 1, connectionName: 'inkquisitor-test-lockout' });
    clients.push(client);
    return client;
}

/** The Upstash REST client's `eval` / `del`, carried by a real Redis connection. */
function upstashOver(client: Redis): UpstashLike {
    return {
        eval: (script, k, args) => client.eval(script, k.length, ...k, ...args),
        del: (key) => client.del(key),
    };
}

const STORES: Array<[string, () => FailureWindowStore]> = [
    ['redis', () => new RedisFailureStore(connection())],
    ['upstash', () => new UpstashFailureStore(upstashOver(connection()))],
];

let t = Date.now();
const now = () => t;

afterAll(async () => {
    const [first] = clients;
    if (first && keys.length > 0) await first.del(...keys.map((k) => `inkq:lockout:${k}`));
    await Promise.all(clients.map((c) => closeRedisClient(c)));
});

describe.each(STORES)('the %s store', (kind, makeStore) => {
    const processOver = () => new ProgressiveLockout(makeStore(), LOGIN_PROGRESSIVE_POLICY, now);

    it('failures recorded by two processes lock both out, and a restart remembers', async () => {
        const key = freshKey(`${kind}-shared`);
        const a = processOver();
        const b = processOver();
        expect(a.storeKind).toBe(kind);
        for (let i = 0; i < LOCK_AT; i++) {
            expect((await (i % 2 ? a : b).attempt(key)).allowed).toBe(true);
            t += 1;
        }
        expect(await a.attempt(key)).toMatchObject({ allowed: false, failureCount: LOCK_AT });
        expect(await b.attempt(key)).toMatchObject({ allowed: false, failureCount: LOCK_AT });

        const restarted = processOver();
        const locked = await restarted.attempt(key);
        expect(locked.allowed).toBe(false);
        expect(locked.retryAfterSeconds).toBeGreaterThan(14 * 60);

        t += LOGIN_PROGRESSIVE_POLICY.lockoutMs;
        expect(await restarted.attempt(key)).toMatchObject({ allowed: true, failureCount: 1 });
        expect((await a.attempt(key)).failureCount).toBe(2);
    });

    it('a success through one process resets the count the other reads', async () => {
        const key = freshKey(`${kind}-reset`);
        const a = processOver();
        const b = processOver();
        for (let i = 0; i < 4; i++) await a.attempt(key);
        expect((await b.attempt(key)).delayMs).toBe(5_000);
        await b.reset(key);
        expect(await a.attempt(key)).toMatchObject({ allowed: true, delayMs: 0, failureCount: 1 });
    });

    it('at nine failures, concurrent attempts from two processes let exactly one verify', async () => {
        const key = freshKey(`${kind}-race-nine`);
        const a = processOver();
        const b = processOver();
        for (let i = 0; i < LOCK_AT - 1; i++) await a.attempt(key);
        const decisions = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).attempt(key)));
        expect(decisions.filter((d) => d.allowed)).toHaveLength(1);
    });

    it('from zero, forty concurrent attempts let exactly the lockout count verify, each with its own count', async () => {
        const key = freshKey(`${kind}-race-zero`);
        const a = processOver();
        const b = processOver();
        const decisions = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).attempt(key)));
        const allowed = decisions.filter((d) => d.allowed);
        expect(allowed).toHaveLength(LOCK_AT);
        expect(allowed.map((d) => d.failureCount).sort((x, y) => x - y)).toEqual(Array.from({ length: LOCK_AT }, (_, i) => i + 1));
    });
});
