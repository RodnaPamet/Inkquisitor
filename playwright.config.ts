import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { STUB_BASE_URL, STUB_PORT } from './tests/e2e/stub-server';

/**
 * Playwright end-to-end tests (tests/e2e).
 *
 * Runs against `next start` — a production build — on a dedicated port so it
 * never collides with `npm run dev` on 3000. Run `npm run build` first; the
 * web server below only starts the built app. Setting URL points the suite at
 * an already-running server instead. `E2E_PORT` moves the port (default 3100)
 * for a machine where that one is taken; the refusal spec starts its own,
 * short-lived server one above it.
 */
const port = Number(process.env.E2E_PORT || 3100);
const isCI = !!process.env.CI;

/**
 * Optional override for the Chromium binary. CI runs `npx playwright install`
 * and never sets it. It exists for machines whose pre-installed browsers are a
 * different build from the one this @playwright/test version expects (the
 * launch then fails with "Executable doesn't exist"), and where downloading
 * the expected build is not possible. Unset, Playwright's own browser is used.
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

/**
 * A stable, obviously-fake value for a production secret the E2E server needs
 * to boot. Stable (not random per run) because the database outlives a run:
 * a workspace's data key is wrapped under DATA_ENCRYPTION_KEY. Assembled here
 * rather than written as a literal so no secret-shaped string sits in the tree.
 */
function e2eOnlyValue(name: string): string {
    return ['e2e', 'only', name, 'not', 'a', 'real', 'value'].join('-').padEnd(48, '-x');
}

/** What either E2E server needs to boot as production, unless the shell already has it. */
function serverEnv(origin: string): Record<string, string> {
    return {
        REDIS_URL: process.env.REDIS_URL || 'redis://:e2e@localhost:6379',
        AV_SCAN_MODE: process.env.AV_SCAN_MODE || 'disabled',
        // Local storage needs an explicit root in production; the smoke uploads
        // nothing, so a temp folder is the right one.
        FILE_STORAGE_ROOT: process.env.FILE_STORAGE_ROOT || path.join(os.tmpdir(), 'inkquisitor-e2e-uploads'),
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/inkquisitor_test?schema=public',
        // Identity and encryption (Phase 0.3), which production requires.
        // Obviously-fake values built here, never real secrets; a shell that
        // exports its own wins.
        AUTH_SECRET: process.env.AUTH_SECRET || e2eOnlyValue('auth'),
        NEXTAUTH_URL: origin,
        DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY || e2eOnlyValue('kek'),
        // The specs call no outside service: no breached-password lookup at sign-up.
        PASSWORD_BREACH_CHECK: process.env.PASSWORD_BREACH_CHECK || 'off',
        // Every spec signs up and in from one address within a minute, which
        // the auth tier (10 a minute) and the sign-up budget (5 an hour) would
        // refuse. The tiers are covered by the unit and integration suites; the
        // smoke covers the flow.
        RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED || '0',
    };
}

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    forbidOnly: isCI,
    retries: isCI ? 2 : 0,
    workers: isCI ? 2 : undefined,
    reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: process.env.URL || `http://localhost:${port}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                ...(chromiumExecutable
                    ? { launchOptions: { executablePath: chromiumExecutable } }
                    : {}),
            },
        },
    ],
    webServer: process.env.URL
        ? undefined
        : [
              {
                  command: `npx next start -p ${port}`,
                  // `next start` runs as production, and production refuses to
                  // start without what it requires (src/lib/startup-checks.ts).
                  // The smoke serves pages and probes only, so it supplies the
                  // required values (no scanner: scanning disabled) unless the
                  // shell already has them.
                  env: {
                      ...serverEnv(`http://localhost:${port}`),
                      // No test reaches a model provider, so the server holds no
                      // ANTHROPIC_API_KEY; production refuses to start without
                      // one unless AI is switched off (src/lib/ai/config.ts). So
                      // the operator's kill switch is on: a session that would
                      // need the model pauses KILL_SWITCH, named, and nothing is
                      // faked. The start-up refusal for the missing key is
                      // production-refusal.spec.ts.
                      AI_DISABLED: process.env.AI_DISABLED || '1',
                  },
                  url: `http://localhost:${port}/api/health`,
                  reuseExistingServer: !isCI,
                  timeout: 120_000,
              },
              {
                  // The interview server (Phase 2.4, tests/e2e/stub-server.ts):
                  // the stubbed model answers every call in-process, so a whole
                  // session runs with nothing sent anywhere. Production accepts
                  // AI_MODEL_STUB=1 only with APP_URL and NEXTAUTH_URL on a
                  // loopback address and no provider key; the refusal on a real
                  // host is production-refusal.spec.ts.
                  command: `npx next start -p ${STUB_PORT}`,
                  env: { ...serverEnv(STUB_BASE_URL), APP_URL: STUB_BASE_URL, AI_MODEL_STUB: '1', AI_DISABLED: '0' },
                  url: `${STUB_BASE_URL}/api/health`,
                  reuseExistingServer: !isCI,
                  timeout: 120_000,
              },
              {
                  // The research worker (Phase 2.6): a research run is a BullMQ
                  // job, so the stub server's runs need a worker. It runs from
                  // source (tsx, as `npm run worker`), as production, with the
                  // same stubbed model and loopback URLs as the stub server, so
                  // the run's gather turn is answered by the stub's fake web and
                  // nothing is sent anywhere. Ready when it logs that it listens.
                  name: 'worker',
                  command: 'npx tsx scripts/worker.ts',
                  env: { ...serverEnv(STUB_BASE_URL), APP_URL: STUB_BASE_URL, AI_MODEL_STUB: '1', AI_DISABLED: '0', NODE_ENV: 'production', LOG_LEVEL: 'info' },
                  wait: { stdout: /listening for jobs/ },
                  stdout: 'pipe',
                  reuseExistingServer: !isCI,
                  timeout: 120_000,
              },
          ],
});
