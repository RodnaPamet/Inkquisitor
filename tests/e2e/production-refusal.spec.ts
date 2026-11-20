import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';

/**
 * The production WEB server refuses to start without DATA_ENCRYPTION_KEY and
 * AUTH_SECRET (Phase 0.H, brief item 2), and — since 2.2, when the question
 * engine made a model call a production feature — without ANTHROPIC_API_KEY
 * unless AI is switched off (issue #30, item 1). The worker's twin is
 * tests/unit/platform/production-refusal.test.ts.
 *
 * Starts the built app (`next start`, so `src/instrumentation.ts` runs its
 * start-up check) with every other variable production requires and with
 * `SKIP_ENV_VALIDATION=1`, the value the build sets and an image is most
 * likely to leak into its runtime. On port 0, so it can collide with nothing,
 * including the suite's own server. It must exit 1 and say why.
 */

const fake = (name: string) => ['refusal', 'test', name, 'not', 'a', 'secret'].join('-').padEnd(48, '-x');

function startServer(overrides: Record<string, string | undefined>): Promise<{ code: number | null; stderr: string }> {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    for (const [k, v] of Object.entries({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'production',
        SKIP_ENV_VALIDATION: '1',
        NEXT_TELEMETRY_DISABLED: '1',
        DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none',
        REDIS_URL: `redis://:${fake('redis')}@127.0.0.1:1`,
        FILE_STORAGE_ROOT: '/nonexistent/inkquisitor-refusal-test',
        AV_SCAN_MODE: 'disabled',
        NEXTAUTH_URL: 'https://inkquisitor.example.test',
        AUTH_SECRET: fake('auth'),
        DATA_ENCRYPTION_KEY: fake('kek'),
        // Required since 2.2 (the question engine calls a model), with a declared retention mode.
        ANTHROPIC_API_KEY: fake('model'),
        AI_RETENTION_MODE: 'zdr',
        ...overrides,
    })) {
        if (v !== undefined) env[k] = v;
    }
    return new Promise((resolve) => {
        const child = spawn('npx', ['next', 'start', '-p', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, stderr });
        });
    });
}

const fatal = (stderr: string) => stderr.split('\n').filter((l) => l.startsWith('[startup] FATAL:'));

test('the server exits 1 without DATA_ENCRYPTION_KEY and AUTH_SECRET, naming both', async () => {
    test.setTimeout(90_000);
    const { code, stderr } = await startServer({ AUTH_SECRET: undefined, DATA_ENCRYPTION_KEY: undefined });
    expect(code).toBe(1);
    const lines = fatal(stderr);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('AUTH_SECRET is required'))).toBe(true);
    expect(lines.some((l) => l.includes('DATA_ENCRYPTION_KEY is required'))).toBe(true);
});

test('and with only the key missing, it names the key', async () => {
    test.setTimeout(90_000);
    const { code, stderr } = await startServer({ DATA_ENCRYPTION_KEY: undefined });
    expect(code).toBe(1);
    expect(fatal(stderr)).toEqual([expect.stringContaining('DATA_ENCRYPTION_KEY is required')]);
});

test('without the model key (AI not switched off), it names the missing key', async () => {
    test.setTimeout(90_000);
    const { code, stderr } = await startServer({ ANTHROPIC_API_KEY: undefined, AI_RETENTION_MODE: undefined });
    expect(code).toBe(1);
    expect(fatal(stderr)).toEqual([expect.stringContaining('ANTHROPIC_API_KEY is required')]);
});

test('with the stubbed model on a real host (Phase 2.4), it refuses the stub by name', async () => {
    test.setTimeout(90_000);
    const { code, stderr } = await startServer({ ANTHROPIC_API_KEY: undefined, AI_RETENTION_MODE: undefined, AI_MODEL_STUB: '1', APP_URL: 'https://inkquisitor.example.test' });
    expect(code).toBe(1);
    expect(fatal(stderr)).toEqual([expect.stringContaining('AI_MODEL_STUB=1 answers every model call with canned questions')]);
});
