/**
 * Both processes ASK the production start-up refusal, first.
 *
 * `startup-checks.test.ts` proves what the refusal decides; this proves the
 * web tier and the worker call it — before anything else starts — so deleting
 * either call fails here (brief item 7: production refuses to start when a
 * required variable is missing).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const calls: string[] = [];
jest.mock('@/lib/startup-checks', () => ({
    enforceProductionConfig: jest.fn((e: unknown) => {
        calls.push(e === process.env ? 'enforce(process.env)' : 'enforce(other)');
    }),
}));
jest.mock('@/lib/security/encryption-sentinel', () => ({ runEncryptionSentinel: jest.fn(() => void calls.push('sentinel')) }));
jest.mock('@/lib/observability/instrumentation', () => ({ initTelemetry: jest.fn(async () => void calls.push('telemetry')) }));
jest.mock('@/lib/observability/sentry', () => ({ initSentry: jest.fn(() => void calls.push('sentry')) }));
jest.mock('@/lib/mailer', () => ({ initMailerFromEnv: jest.fn(() => void calls.push('mailer')) }));
jest.mock('@/lib/observability/shutdown', () => ({ installShutdownHandlers: jest.fn(() => void calls.push('shutdown')) }));

import { registerNode } from '@/instrumentation-node';

const ROOT = path.resolve(__dirname, '../../..');

it('the web tier enforces the production configuration with process.env before anything initialises', async () => {
    calls.length = 0;
    await registerNode();
    expect(calls).toEqual(['enforce(process.env)', 'sentinel', 'telemetry', 'sentry', 'mailer', 'shutdown']);
});

it('the worker refuses to start in production without REDIS_URL, before it connects to anything', () => {
    // SKIP_ENV_VALIDATION=1 is the case the refusal exists for: the one
    // variable an image is most likely to carry. REDIS_URL points nowhere
    // reachable, so a worker that got past the refusal would hang or log a
    // connection error rather than print the FATAL line.
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'production',
        SKIP_ENV_VALIDATION: '1',
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/none',
        CLAMAV_HOST: '127.0.0.1:1',
        LOG_LEVEL: 'silent',
    };
    const result = spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), ['scripts/worker.ts'], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toMatch(/^\[startup\] FATAL: REDIS_URL is required/m);
    expect(result.status).toBe(1);
}, 70_000);

it('`npm run worker` loads .env (and .env.local) the way `next dev` does: the worker reads src/env.ts too', () => {
    // tsx does not read .env, and DATABASE_URL is required by the schema, so
    // without the flags a developer following the README could not start it.
    // The production bundle (node dist/worker.mjs) reads the real environment.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.worker).toBe('tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/worker.ts');
});
