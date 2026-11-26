/**
 * Fixtures for book-level interrogation (Phase 4.3, D29), made through the
 * product's own usecases: a stress test run by a scripted tester, a gap hunt,
 * and a compaction of a long session. Nothing reaches a network.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { InterviewCompactionRepository } from '@/app-layer/repositories/interrogation.repository';
import { getStressTestPage, executeStressTest, startStressTest, type StressTestDeps } from '@/app-layer/usecases/stress-tests';
import { runGapHunt } from '@/app-layer/usecases/gap-hunts';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { sanitiseSummaryForStorage } from '@/lib/interview/compaction-prompt';
import type { FactExtractor } from '@/lib/sources/extractor';
import { setFakeApiKey } from './fake-anthropic';

export const MOUNTED = () => ({ mounted: true as const, recordKind: 'structural' as const });

/** A scripted tester answering `output` (a function of the blocks it was shown, or a fixed answer). */
export function scriptedTester(output: unknown | ((blocks: ReadonlyArray<{ label: string; text: string }>) => unknown), seen: Array<ReadonlyArray<{ label: string; text: string }>> = []): () => FactExtractor {
    return () => ({
        async extract(request) {
            seen.push(request.data);
            return { ok: true, output: typeof output === 'function' ? (output as (b: typeof request.data) => unknown)(request.data) : output, tokensUsed: 10, costMicroUsd: 1_000, callIds: [] };
        },
    });
}

/**
 * Start a stress test at the page's own "at most" and run its job, the deps given (a fake key so the deployment can
 * call; the structural record mounts by default). Returns the test's id and the job's outcome.
 */
export async function runStressTest(ctx: WorkspaceRequestContext, bookId: string, deps: StressTestDeps = {}): Promise<{ id: string; outcome: string | null }> {
    const undo = setFakeApiKey();
    try {
        const page = await getStressTestPage(ctx, bookId, { gate: MOUNTED, ...deps });
        const queued: string[] = [];
        const view = await startStressTest(ctx, bookId, { confirmWorstCaseMicroUsd: page.estimate!.worstMicroUsd }, { gate: MOUNTED, enqueue: async (p) => void queued.push(p.stressTestId), ...deps });
        const r = await executeStressTest({ workspaceId: ctx.workspaceId, stressTestId: queued[0] }, { gate: MOUNTED, charge: () => undefined, ...deps });
        return { id: view.id, outcome: r.outcome };
    } finally {
        undo();
    }
}

/** A row in every interrogation table: a stress test with a weak point, a gap hunt, and a compaction of `sessionId` (an interview the caller seeded). */
export async function seedInterrogation(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, marker: string): Promise<void> {
    const r = await runStressTest(ctx, bookId, {
        tester: scriptedTester({ weakPoints: [{ kind: 'OTHER', title: `A thin place ${marker.replace(/[^a-z]/gi, '')}`, questions: ['What does this character want most?'], cites: ['E1'] }] }),
    });
    if (r.outcome !== 'OK') throw new Error(`the interrogation fixture's stress test ended ${String(r.outcome)}`);
    await runGapHunt(ctx, bookId, {});
    await runInWorkspaceContext(ctx, (db) =>
        InterviewCompactionRepository.create(db, ctx.workspaceId, { sessionId, throughRound: 1, summary: sanitiseSummaryForStorage(`Round one asked about the role (${marker}).`), promptVersion: 'rounds-summary.4.3.0', tokensUsed: 1, costMicroUsd: 1 }),
    );
}
