/**
 * A production server whose configuration fails to LOAD exits 1.
 *
 * The env schema throws at module load (REDIS_URL missing with validation on,
 * an invalid URL, …). Next treats a throw from the instrumentation hook as
 * "Failed to prepare server" and keeps the process running, answering 500 on
 * every route, /api/livez included. So `registerNode` must run the refusal
 * before loading any `@/env` importer, and turn a load failure into exit 1.
 */
jest.mock('@/lib/startup-checks', () => ({ enforceProductionConfig: jest.fn() }));
jest.mock('@/lib/observability/instrumentation', () => {
    throw new Error('Invalid environment variables\n  REDIS_URL: REDIS_URL is REQUIRED in production');
});
jest.mock('@/lib/observability/sentry', () => ({ initSentry: jest.fn() }));
jest.mock('@/lib/mailer', () => ({ initMailerFromEnv: jest.fn() }));
jest.mock('@/lib/observability/shutdown', () => ({ installShutdownHandlers: jest.fn() }));

import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerNode } from '@/instrumentation-node';
import { enforceProductionConfig } from '@/lib/startup-checks';

const env = process.env as Record<string, string | undefined>;
const saved = { NODE_ENV: env.NODE_ENV, NEXT_PHASE: env.NEXT_PHASE };

afterEach(() => {
    env.NODE_ENV = saved.NODE_ENV;
    env.NEXT_PHASE = saved.NEXT_PHASE;
    if (saved.NEXT_PHASE === undefined) delete env.NEXT_PHASE;
});

it('production: a service that fails to load is a FATAL line and exit 1, after the refusal ran', async () => {
    env.NODE_ENV = 'production';
    delete env.NEXT_PHASE;
    const lines: string[] = [];
    const exit = jest.fn();
    await registerNode({ report: (l) => void lines.push(l), exit });
    expect(enforceProductionConfig).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toEqual([
        "[startup] FATAL: the server's configuration failed to load: Invalid environment variables",
    ]);
});

it('development: the load error is thrown as it is, so the dev overlay shows it', async () => {
    env.NODE_ENV = 'development';
    const exit = jest.fn();
    await expect(registerNode({ report: () => undefined, exit })).rejects.toThrow(/Invalid environment variables/);
    expect(exit).not.toHaveBeenCalled();
});

it('next build is not a running server: the error is thrown, not an exit', async () => {
    env.NODE_ENV = 'production';
    env.NEXT_PHASE = 'phase-production-build';
    const exit = jest.fn();
    await expect(registerNode({ report: () => undefined, exit })).rejects.toThrow();
    expect(exit).not.toHaveBeenCalled();
});

it('instrumentation-node.ts statically imports no module that loads @/env', () => {
    // A static import is evaluated before registerNode's first line, so the
    // env schema would throw before the refusal could run.
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/instrumentation-node.ts'), 'utf8');
    const staticImports = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(staticImports.sort()).toEqual(['@/lib/build-phase', '@/lib/startup-checks']);
    for (const p of ['src/lib/startup-checks.ts', 'src/lib/build-phase.ts']) {
        const dep = fs.readFileSync(path.resolve(__dirname, '../../..', p), 'utf8');
        expect(dep).not.toMatch(/from '@\/env'/);
    }
});
