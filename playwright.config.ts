import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright end-to-end tests (tests/e2e).
 *
 * Runs against `next start` — a production build — on a dedicated port so it
 * never collides with `npm run dev` on 3000. Run `npm run build` first; the
 * web server below only starts the built app. Setting URL points the suite at
 * an already-running server instead.
 */
const port = 3100;
const isCI = !!process.env.CI;

/**
 * Optional override for the Chromium binary. CI runs `npx playwright install`
 * and never sets it. It exists for machines whose pre-installed browsers are a
 * different build from the one this @playwright/test version expects (the
 * launch then fails with "Executable doesn't exist"), and where downloading
 * the expected build is not possible. Unset, Playwright's own browser is used.
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

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
        : {
              command: `npx next start -p ${port}`,
              url: `http://localhost:${port}/api/health`,
              reuseExistingServer: !isCI,
              timeout: 120_000,
          },
});
