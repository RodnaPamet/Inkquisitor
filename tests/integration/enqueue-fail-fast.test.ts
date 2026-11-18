/**
 * `enqueue` fails, rather than hangs, when Redis is unreachable.
 *
 * BullMQ waits for its first connection with no limit of its own, so before
 * the bound an HTTP request that enqueued during a Redis outage never
 * answered. The URL is a closed local port (nothing listens on 1), so the
 * connection is refused locally and nothing leaves the machine.
 */
process.env.REDIS_URL = 'redis://127.0.0.1:1';

import { enqueue, closeQueue } from '@/app-layer/jobs/queue';
import { AppError } from '@/lib/errors/types';

afterAll(async () => {
    await closeQueue();
});

it('rejects with a 502 AppError within its timeout', async () => {
    const started = Date.now();
    const attempt = enqueue('heartbeat', { enqueuedAt: new Date().toISOString() }, {
        queueName: `inkquisitor-unreachable-${process.pid}`,
        timeoutMs: 300,
    });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ status: 502, code: 'EXTERNAL_SERVICE_ERROR' });
    expect(Date.now() - started).toBeLessThan(5_000);
}, 15_000);
