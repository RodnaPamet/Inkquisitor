/**
 * Production refuses to start without DATA_ENCRYPTION_KEY and AUTH_SECRET —
 * proved on a real process, not on the pure function alone (Phase 0.H, brief
 * item 2). `startup-checks.test.ts` covers every rule of
 * `productionConfigProblems`; this suite starts the worker the way production
 * does (scripts/worker.ts, through tsx as `npm run worker` does) and reads its
 * exit code and stderr.
 *
 * The web tier is the same check through `src/instrumentation-node.ts`, and is
 * started for real by tests/e2e/production-refusal.spec.ts (it needs the build).
 *
 * Each case gives the process every OTHER variable production requires, so the
 * only problems it can report are the two under test. `SKIP_ENV_VALIDATION=1`
 * is set in the first cases on purpose: it is the variable an image is most
 * likely to carry by accident (the build sets it), and the start-up check must
 * hold with schema validation off. Nothing listens on the URLs given; the
 * process must exit before it would dial any of them.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { REPO_ROOT } from '../../helpers/repo-files';
import { DEV_FALLBACK_AUTH_SECRET } from '@/lib/auth/auth-constants';

const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/** Obviously fake values of the right length, assembled at run time. */
const fake = (name: string) => ['refusal', 'test', name, 'not', 'a', 'secret'].join('-').padEnd(48, '-x');

function productionEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const base: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none',
        REDIS_URL: `redis://:${fake('redis')}@127.0.0.1:1`,
        FILE_STORAGE_ROOT: '/nonexistent/inkquisitor-refusal-test',
        AV_SCAN_MODE: 'disabled',
        NEXTAUTH_URL: 'https://inkquisitor.example.test',
        AUTH_SECRET: fake('auth'),
        DATA_ENCRYPTION_KEY: fake('kek'),
        LOG_LEVEL: 'silent',
        ...overrides,
    };
    return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;
}

function startWorker(env: NodeJS.ProcessEnv) {
    const r = spawnSync(TSX, ['scripts/worker.ts'], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, signal: r.signal, stderr: r.stderr ?? '' };
}

const fatalLines = (stderr: string) => stderr.split('\n').filter((l) => l.startsWith('[startup] FATAL:'));

describe('the worker refuses to start in production', () => {
    it('without DATA_ENCRYPTION_KEY and AUTH_SECRET, exiting 1 and naming both (validation skipped)', () => {
        const r = startWorker(productionEnv({ SKIP_ENV_VALIDATION: '1', AUTH_SECRET: undefined, DATA_ENCRYPTION_KEY: undefined }));
        expect(r.status).toBe(1);
        const fatal = fatalLines(r.stderr);
        expect(fatal).toHaveLength(2);
        expect(fatal.some((l) => l.includes('AUTH_SECRET is required'))).toBe(true);
        expect(fatal.some((l) => l.includes('DATA_ENCRYPTION_KEY is required'))).toBe(true);
    }, 60_000);

    it.each([
        ['AUTH_SECRET', { AUTH_SECRET: undefined }],
        ['DATA_ENCRYPTION_KEY', { DATA_ENCRYPTION_KEY: undefined }],
        ['AUTH_SECRET', { AUTH_SECRET: 'too-short' }],
        ['AUTH_SECRET', { AUTH_SECRET: DEV_FALLBACK_AUTH_SECRET }],
    ])('refuses when %s alone is missing or unfit', (name, overrides) => {
        const r = startWorker(productionEnv({ SKIP_ENV_VALIDATION: '1', ...overrides }));
        expect(r.status).toBe(1);
        const fatal = fatalLines(r.stderr);
        expect(fatal).toHaveLength(1);
        expect(fatal[0]).toContain(name);
    }, 60_000);

    it('with schema validation ON, the env schema refuses first, naming both, and the process exits non-zero', () => {
        const r = startWorker(productionEnv({ AUTH_SECRET: undefined, DATA_ENCRYPTION_KEY: undefined }));
        expect(r.status).not.toBe(0);
        expect(r.signal).toBeNull();
        expect(r.stderr).toContain('AUTH_SECRET');
        expect(r.stderr).toContain('DATA_ENCRYPTION_KEY');
    }, 60_000);
});
