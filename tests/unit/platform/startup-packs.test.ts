/**
 * A production server whose question packs will not load exits 1 at boot
 * (Phase 2.2). The packs are read from disk (`src/lib/interview/packs.ts`),
 * so an image that lost the directory, or a pack an edit broke, would
 * otherwise first fail at an author's interview.
 */
jest.mock('@/lib/startup-checks', () => ({ enforceProductionConfig: jest.fn() }));
jest.mock('@/lib/security/encryption-sentinel', () => ({ runEncryptionSentinel: jest.fn() }));
jest.mock('@/lib/interview/packs', () => ({
    getPacks: jest.fn(() => {
        throw new Error("ENOENT: no such file or directory, open '/app/src/lib/interview/packs/craft/character/PACK.md'");
    }),
}));
jest.mock('@/lib/observability/instrumentation', () => ({ initTelemetry: jest.fn() }));
jest.mock('@/lib/observability/sentry', () => ({ initSentry: jest.fn() }));
jest.mock('@/lib/mailer', () => ({ initMailerFromEnv: jest.fn() }));
jest.mock('@/lib/observability/shutdown', () => ({ installShutdownHandlers: jest.fn() }));

import { registerNode } from '@/instrumentation-node';
import { initTelemetry } from '@/lib/observability/instrumentation';

const env = process.env as Record<string, string | undefined>;
const saved = { NODE_ENV: env.NODE_ENV, NEXT_PHASE: env.NEXT_PHASE };

afterEach(() => {
    env.NODE_ENV = saved.NODE_ENV;
    if (saved.NEXT_PHASE === undefined) delete env.NEXT_PHASE;
    else env.NEXT_PHASE = saved.NEXT_PHASE;
});

it('production: a FATAL line naming the packs, and exit 1, before anything initialises', async () => {
    env.NODE_ENV = 'production';
    delete env.NEXT_PHASE;
    const lines: string[] = [];
    const exit = jest.fn();
    await registerNode({ report: (l) => void lines.push(l), exit });
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toEqual([expect.stringMatching(/^\[startup\] FATAL: the question packs failed to load: ENOENT/)]);
    expect(initTelemetry).not.toHaveBeenCalled();
});

it('development: the error is thrown as it is', async () => {
    env.NODE_ENV = 'development';
    const exit = jest.fn();
    await expect(registerNode({ report: () => undefined, exit })).rejects.toThrow(/ENOENT/);
    expect(exit).not.toHaveBeenCalled();
});
