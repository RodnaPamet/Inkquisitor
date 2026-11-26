/**
 * The worker's shutdown reaches a running job (#57 item 6, Phase 4.1): the
 * executors of the long jobs hand their usecase the process's shutdown signal,
 * and aborting it (the worker's first step on SIGTERM) aborts what they hold.
 */
const seen: Array<{ job: string; signal: AbortSignal | undefined }> = [];
jest.mock('@/app-layer/usecases/source-ingest', () => ({
    executeSourceIngest: async (_p: unknown, deps: { signal?: AbortSignal } = {}) => {
        seen.push({ job: 'source-ingest', signal: deps.signal });
        return { ran: true, outcome: 'OK' };
    },
}));
jest.mock('@/app-layer/usecases/bible-facts', () => ({
    executeBibleFactExtraction: async (_p: unknown, deps: { signal?: AbortSignal } = {}) => {
        seen.push({ job: 'bible-facts', signal: deps.signal });
        return { ran: true, outcome: 'OK' };
    },
}));

import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import { abortRunningJobs, jobShutdownSignal, _resetJobShutdownSignal } from '@/app-layer/jobs/shutdown-signal';

afterEach(() => _resetJobShutdownSignal());

it('a source ingestion and a bible fact extraction are handed the shutdown signal, which the worker aborts', async () => {
    _resetJobShutdownSignal();
    await executorRegistry.execute('source-ingest', { workspaceId: 'w', sourceId: 's' });
    await executorRegistry.execute('bible-facts', { workspaceId: 'w', extractionId: 'x' });
    expect(seen.map((s) => s.job)).toEqual(['source-ingest', 'bible-facts']);
    for (const s of seen) {
        expect(s.signal).toBe(jobShutdownSignal());
        expect(s.signal!.aborted).toBe(false);
    }
    abortRunningJobs();
    expect(seen.every((s) => s.signal!.aborted)).toBe(true);
});

it('the worker aborts running jobs before it closes (BullMQ’s close waits for the active job)', () => {
    const fs = jest.requireActual('node:fs') as typeof import('node:fs');
    const worker = fs.readFileSync('scripts/worker.ts', 'utf8');
    const shutdown = worker.slice(worker.indexOf('async function shutdown'));
    expect(shutdown.indexOf('abortRunningJobs()')).toBeGreaterThan(0);
    expect(shutdown.indexOf('abortRunningJobs()')).toBeLessThan(shutdown.indexOf('worker?.close()'));
});
