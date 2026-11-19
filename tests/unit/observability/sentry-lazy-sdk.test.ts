/**
 * The Sentry SDK is loaded only when a DSN is configured (issue #9).
 *
 * Importing `@sentry/nextjs` takes an `AsyncLocalStorage.snapshot()` at module
 * load, a resource that lives for the rest of the process; `jest
 * --detectOpenHandles` reported it from every suite that reached the route
 * wrapper or the job runner. Every reporting path must therefore work, as a
 * no-op, without the SDK ever being required. The factory below counts
 * requires: a static import anywhere in the sentry module's graph, or an
 * eager load in any of its functions, makes it non-zero.
 */
let sdkLoads = 0;
jest.mock('@sentry/nextjs', () => {
    sdkLoads += 1;
    return { init: jest.fn(), getClient: () => ({}), withScope: jest.fn(), captureException: jest.fn(() => 'evt'), close: jest.fn(async () => true) };
});

import { AppError } from '@/lib/errors/types';

beforeEach(() => {
    jest.resetModules();
    sdkLoads = 0;
    delete process.env.SENTRY_DSN;
});

it('without a DSN, init, capture, the health read and shutdown never load the SDK', async () => {
    const sentry = await import('@/lib/observability/sentry');
    await import('@/lib/errors/api');
    await import('@/lib/observability/job-runner');
    await sentry.initSentry();
    expect(sentry.captureError(new AppError('boom', 'INTERNAL', 500), { status: 500 })).toBeUndefined();
    expect(sentry.isSentryInitialized()).toBe(false);
    await sentry.shutdownSentry(10);
    expect(sdkLoads).toBe(0);
});

it('with a DSN, initSentry loads it once and reporting goes through it', async () => {
    process.env.SENTRY_DSN = 'https://public@sentry.example.test/1';
    const sentry = await import('@/lib/observability/sentry');
    await sentry.initSentry();
    await sentry.initSentry();
    expect(sdkLoads).toBe(1);
    expect(sentry.isSentryInitialized()).toBe(true);
});
