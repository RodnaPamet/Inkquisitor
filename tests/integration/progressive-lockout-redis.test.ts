/**
 * The sign-in lockout over a real Redis, as production counts it (issue #10).
 *
 * Two `ProgressiveLockout` instances, each on its OWN Redis connection, stand
 * for two web processes. Failures recorded through either lock out both, a
 * success through either resets both, and the decision survives a
 * "restart" (a fresh instance and connection over the same data). Logical
 * database 14 and a key of this run's own (tests/helpers/test-redis.ts).
 */
import Redis from 'ioredis';
import { ProgressiveLockout, RedisFailureStore } from '@/lib/security/progressive-lockout';
import { LOGIN_PROGRESSIVE_POLICY } from '@/lib/security/rate-limit';
import { closeRedisClient } from '@/lib/redis';
import { testRedisUrl } from '../helpers/test-redis';

const KEY = `login-progressive:it-${process.pid}-${Date.now()}`;
const LOCK_AT = LOGIN_PROGRESSIVE_POLICY.lockoutAtFailures;
const clients: Redis[] = [];

function processOver(now: () => number): ProgressiveLockout {
    const client = new Redis(testRedisUrl(), { maxRetriesPerRequest: 1, connectionName: 'inkquisitor-test-lockout' });
    clients.push(client);
    return new ProgressiveLockout(new RedisFailureStore(client), LOGIN_PROGRESSIVE_POLICY, now);
}

let t = Date.now();
const now = () => t;

afterAll(async () => {
    const [first] = clients;
    await first?.del(`inkq:lockout:${KEY}`);
    await Promise.all(clients.map((c) => closeRedisClient(c)));
});

it('failures recorded by two processes lock both out, and a restart remembers', async () => {
    const a = processOver(now);
    const b = processOver(now);
    expect(a.storeKind).toBe('redis');
    await a.reset(KEY);
    for (let i = 0; i < LOCK_AT; i++) {
        await (i % 2 ? a : b).recordFailure(KEY);
        t += 1;
    }
    expect(await a.evaluate(KEY)).toMatchObject({ allowed: false, failureCount: LOCK_AT });
    expect(await b.evaluate(KEY)).toMatchObject({ allowed: false, failureCount: LOCK_AT });

    const restarted = processOver(now);
    expect((await restarted.evaluate(KEY)).allowed).toBe(false);

    t += LOGIN_PROGRESSIVE_POLICY.lockoutMs;
    expect(await restarted.evaluate(KEY)).toMatchObject({ allowed: true, failureCount: 0 });
    expect((await a.evaluate(KEY)).failureCount).toBe(0);
});

it('a success through one process resets the count the other reads', async () => {
    const a = processOver(now);
    const b = processOver(now);
    await a.reset(KEY);
    for (let i = 0; i < 4; i++) await a.recordFailure(KEY);
    expect((await b.evaluate(KEY)).delayMs).toBe(5_000);
    await b.reset(KEY);
    expect(await a.evaluate(KEY)).toMatchObject({ allowed: true, delayMs: 0, failureCount: 0 });
});
