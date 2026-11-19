/**
 * `closeRedisClient` leaves nothing behind that keeps the process alive
 * (issue #9).
 *
 * The defect: ioredis answers `disconnect()` by arming a 2-second timer that
 * waits for its socket's `close` event. A socket that was REFUSED closed
 * before that and never closes again, so the timer always ran out, and the
 * integration run ended with "Jest did not exit one second after the test run
 * has completed". The readiness probe's client and the queue's producer both
 * meet a refused Redis in their suites. Measured here as the process's live
 * `Timeout` resources, which is what keeps an event loop alive.
 *
 * Port 1 on loopback is closed, so the connection is refused locally and
 * nothing leaves the machine.
 */
import Redis from 'ioredis';
import { closeRedisClient } from '@/lib/redis';
import { testRedisUrl } from '../helpers/test-redis';

const liveTimeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function until(predicate: () => boolean, ms = 3_000): Promise<void> {
    const deadline = Date.now() + ms;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (predicate()) return resolve();
            if (Date.now() > deadline) return reject(new Error('condition not reached'));
            setImmediate(poll);
        };
        poll();
    });
}

it('a client whose connection was refused closes with no timer left running', async () => {
    const before = liveTimeouts();
    const client = new Redis('redis://127.0.0.1:1', {
        maxRetriesPerRequest: 1,
        // A long back-off, so the client is sitting in `reconnecting` with its
        // refused socket when it is closed: the state that leaked.
        retryStrategy: () => 60_000,
    });
    client.on('error', () => undefined);
    await until(() => client.status === 'reconnecting');

    await closeRedisClient(client);
    await tick();
    // ioredis has nothing left to run for it: no reconnect, no socket timer.
    expect(liveTimeouts()).toBeLessThanOrEqual(before);
});

it('a connected client is QUIT and leaves nothing either', async () => {
    const before = liveTimeouts();
    const client = new Redis(testRedisUrl(), { maxRetriesPerRequest: 1 });
    expect(await client.ping()).toBe('PONG');
    await closeRedisClient(client);
    await until(() => client.status === 'end', 500);
    expect(liveTimeouts()).toBeLessThanOrEqual(before);
});

it('closing a client twice is harmless', async () => {
    const client = new Redis(testRedisUrl(), { lazyConnect: true });
    await closeRedisClient(client);
    await closeRedisClient(client);
    expect(client.status).toBe('end');
});
