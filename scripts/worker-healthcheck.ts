/**
 * Container healthcheck for the worker: exit 0 when the heartbeat key exists
 * (a job completed within its TTL), 1 otherwise. Bundled to
 * dist/worker-healthcheck.mjs, because the runtime image carries no source.
 *
 *   healthcheck: ["CMD", "node", "dist/worker-healthcheck.mjs"]
 *
 * Adapted from inflect-compliance's `scripts/worker-healthcheck.ts`.
 */
import { createRedisClient } from '../src/lib/redis';
import { isWorkerHealthy } from '../src/app-layer/jobs/heartbeat';

async function main(): Promise<number> {
    const client = createRedisClient(undefined, 'inkquisitor-healthcheck');
    // A probe must answer within its own timeout, never hang on a reconnect.
    const timer = setTimeout(() => process.exit(1), 5_000);
    try {
        return (await isWorkerHealthy(client)) ? 0 : 1;
    } finally {
        clearTimeout(timer);
        client.disconnect();
    }
}

main().then(
    (code) => process.exit(code),
    () => process.exit(1),
);
