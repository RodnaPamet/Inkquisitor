/**
 * The worker's proof that it is CONSUMING, not merely running.
 *
 * Written from the BullMQ worker's `completed` event, never from a timer: a
 * `setInterval` keeps ticking through a severed Redis connection and would
 * report a wedged worker as healthy. Reaching `beat()` means Redis answered,
 * the event loop is responsive, a concurrency slot was free and an executor
 * ran. On a quiet queue the `heartbeat` schedule (every 2 minutes) gives the
 * worker something to complete.
 *
 * Nothing deletes the key; it EXPIRES. A worker that stops completing jobs
 * stops refreshing it, and `scripts/worker-healthcheck.ts` reads its absence
 * as unhealthy. The TTL is sized for four missed beats, so a healthy worker
 * never flaps.
 *
 * Adapted from inflect-compliance's `src/app-layer/jobs/worker-heartbeat.ts`.
 */
import type Redis from 'ioredis';

export const WORKER_HEARTBEAT_KEY = 'inkquisitor:worker:heartbeat';

/** Eight minutes: four missed two-minute beats. */
export const WORKER_HEARTBEAT_TTL_SECONDS = 8 * 60;

/** Refresh the heartbeat. Never throws: a monitoring write must not fail a job. */
export async function beat(connection: Pick<Redis, 'set'>, now: () => number = Date.now): Promise<void> {
    try {
        await connection.set(WORKER_HEARTBEAT_KEY, String(now()), 'EX', WORKER_HEARTBEAT_TTL_SECONDS);
    } catch {
        // One missed beat; four are needed before anything reads unhealthy.
    }
}

/** True when the heartbeat key exists, i.e. a job completed within the TTL. */
export async function isWorkerHealthy(connection: Pick<Redis, 'exists'>): Promise<boolean> {
    try {
        return (await connection.exists(WORKER_HEARTBEAT_KEY)) === 1;
    } catch {
        return false;
    }
}
