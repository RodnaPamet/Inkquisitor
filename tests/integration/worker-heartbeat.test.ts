/**
 * The job wiring end to end, against a real Redis: `enqueue('heartbeat')`
 * puts a job on a queue, the real Worker (`createJobWorker`) pulls it, the
 * executor registry runs the no-op, and the `completed` event writes the
 * heartbeat key that the container healthcheck reads.
 *
 * A queue name of its own, on Redis database 14, so nothing here meets a
 * worker or a dev server sharing the Redis.
 */
import { Writable } from 'node:stream';
import type { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { testRedisUrl } from '../helpers/test-redis';

const queueName = `inkquisitor-jobs-test-${process.pid}-${Date.now()}`;
process.env.REDIS_URL = testRedisUrl();

// Imported after REDIS_URL is set: the queue's connection reads it.
import { enqueue, closeQueue } from '@/app-layer/jobs/queue';
import { createJobWorker } from '@/app-layer/jobs/worker';
import { WORKER_HEARTBEAT_KEY, isWorkerHealthy } from '@/app-layer/jobs/heartbeat';
import { createRedisClient } from '@/lib/redis';
import { createProcessLogger } from '@/lib/observability/process-logger';
import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import { OTEL_CARRIER_KEY } from '@/lib/observability/job-trace';

// jest.setup.js silences logs; this suite reads the worker's.
process.env.LOG_LEVEL = 'info';
const lines: string[] = [];
const log = createProcessLogger(
    'worker',
    new Writable({
        write(chunk, _e, cb) {
            lines.push(String(chunk));
            cb();
        },
    }),
);

let connection: Redis;
let worker: Worker;

beforeAll(async () => {
    connection = createRedisClient(testRedisUrl(), 'inkquisitor-test');
    await connection.del(WORKER_HEARTBEAT_KEY);
    worker = createJobWorker({ connection, log, queueName });
    await worker.waitUntilReady();
});

afterAll(async () => {
    await worker?.close();
    await closeQueue();
    await connection.del(WORKER_HEARTBEAT_KEY);
    await connection.quit();
});

it('a heartbeat job travels queue → worker → executor and refreshes the heartbeat', async () => {
    expect(await isWorkerHealthy(connection)).toBe(false);

    // What the executor is handed, through the real registry.
    const realExecute = executorRegistry.execute.bind(executorRegistry);
    const handed: unknown[] = [];
    const spy = jest.spyOn(executorRegistry, 'execute').mockImplementation(async (name, payload, ctx) => {
        handed.push(payload);
        return realExecute(name, payload, ctx);
    });

    const completed = new Promise<unknown>((resolve, reject) => {
        worker.once('completed', (_job, result) => resolve(result));
        worker.once('failed', (_job, err) => reject(err));
    });
    const job = await enqueue('heartbeat', { enqueuedAt: new Date().toISOString() }, { queueName });
    expect(job.id).toBeTruthy();

    const result = await completed;
    spy.mockRestore();
    expect(result).toMatchObject({ jobName: 'heartbeat', success: true });

    // The enqueued job carried the trace carrier; the worker stripped it
    // before the executor saw the payload.
    expect(job.data).toHaveProperty(OTEL_CARRIER_KEY);
    expect(handed).toHaveLength(1);
    expect(handed[0]).not.toHaveProperty(OTEL_CARRIER_KEY);
    expect(handed[0]).toHaveProperty('enqueuedAt');

    // `beat` runs from the same event; give it its round trip.
    for (let i = 0; i < 50 && !(await isWorkerHealthy(connection)); i++) {
        await new Promise((r) => setTimeout(r, 20));
    }
    expect(await isWorkerHealthy(connection)).toBe(true);
    const ttl = await connection.ttl(WORKER_HEARTBEAT_KEY);
    expect(ttl).toBeGreaterThan(0);

    // The worker logged the job by name and id; the trace carrier never reached the executor.
    const processed = lines.map((l) => JSON.parse(l)).find((e) => e.msg === 'job processed');
    expect(processed).toMatchObject({ jobName: 'heartbeat', jobId: job.id, requestId: 'worker' });
}, 20_000);
