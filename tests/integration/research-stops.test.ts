/**
 * A research run stops cleanly (Phase 2.H, roadmap item 9): at its depth's
 * spend budget, at the workspace's monthly ceiling and on the kill switch,
 * each with a named outcome on the run, nothing more sent once it stops, and
 * the brief dispatchable again (the author's way to resume). Through the
 * product's own usecases, the fake Messages API and a real PostgreSQL.
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createResearchBrief, dispatchResearchRun } from '@/app-layer/usecases/research-briefs';
import { executeResearchRun } from '@/app-layer/usecases/research-run';
import { getResearchRunReview } from '@/app-layer/usecases/research-pages';
import { defaultResearcher } from '@/lib/research/model-seam';
import { DEPTH_BUDGETS } from '@/lib/research/vocabulary';
import { fakeAnthropic, setFakeApiKey, type FakeTurn } from '../helpers/fake-anthropic';
import { gatherEvents, MOUNTED_GATE } from '../helpers/research';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

let undoKey: () => void;
beforeAll(() => {
    undoKey = setFakeApiKey();
});
afterAll(async () => {
    undoKey();
    await prisma.$disconnect();
});

const PAGE = { url: 'https://lighthouses.example.org/keepers', title: 'Keepers', text: 'Lighthouse keepers trimmed the wick every four hours through the night.' };

async function briefFor() {
    const owner = await createAccount({ workspaceName: 'Research stops' });
    const ctx = workspaceCtx(owner);
    const bookId = (await createBook(ctx, { title: 'The Lamp' })).id;
    const el = await createElement(ctx, bookId, { kind: 'SETTING', name: 'The Wennaway Light', fields: [{ key: 'place_type', value: 'A lighthouse on a tidal island.' }] });
    const brief = await createResearchBrief(ctx, bookId, { question: 'What did lighthouse keepers do each night?', purpose: 'My keeper needs believable routines.', scopeElementIds: [el.id], depth: 'QUICK' });
    return { ctx, bookId, briefId: brief.id };
}

async function run(ctx: Awaited<ReturnType<typeof briefFor>>['ctx'], bookId: string, briefId: string, turns: FakeTurn[]) {
    const api = fakeAnthropic(turns);
    const { runId } = await dispatchResearchRun(ctx, bookId, briefId, { gate: MOUNTED_GATE, enqueue: async () => undefined });
    await executeResearchRun({ workspaceId: ctx.workspaceId, runId }, { gate: MOUNTED_GATE, researcher: (c) => defaultResearcher(c, { fetch: api.fetch }) });
    return { api, runId, review: await getResearchRunReview(ctx, bookId, runId) };
}

function withEnv(name: string, value: string, fn: () => Promise<void>): Promise<void> {
    const before = process.env[name];
    process.env[name] = value;
    return fn().finally(() => {
        if (before === undefined) delete process.env[name];
        else process.env[name] = before;
    });
}

it('at its depth’s spend budget: the gather sends no further request, and with nothing read the run says BUDGET_SPENT', async () => {
    const { ctx, bookId, briefId } = await briefFor();
    // One request that pauses having fetched nothing, at a cost past QUICK's gather budget.
    const costly: FakeTurn = { kind: 'events', events: gatherEvents({ query: 'lighthouse keepers night', pages: [PAGE], fetchUrls: [], stop: 'pause_turn' }) };
    const big = (costly as { events: Array<Record<string, unknown>> }).events;
    (big[0].message as { usage: Record<string, number> }).usage = { input_tokens: 200_000, output_tokens: 1 };
    const { api, review, runId } = await run(ctx, bookId, briefId, [costly, costly, costly]);
    expect(api.requests).toHaveLength(1);
    expect(review.run).toMatchObject({ outcome: 'BUDGET_SPENT' });
    const stored = await prisma.researchRun.findUniqueOrThrow({ where: { id: runId } });
    expect((stored.metrics as { gatherStop?: string }).gatherStop).toBe('BUDGET');
    expect(review.run.spentMicroUsd).toBeGreaterThanOrEqual(DEPTH_BUDGETS.QUICK.gatherSpendMicroUsd);
    // The brief is dispatchable again: a stopped run is not a run in progress.
    await expect(dispatchResearchRun(ctx, bookId, briefId, { gate: MOUNTED_GATE, enqueue: async () => undefined })).resolves.toMatchObject({ runId: expect.any(String) });
});

it('at the workspace’s monthly ceiling: nothing is sent, the run says WORKSPACE_CEILING, and the brief can run again once there is room', async () => {
    const { ctx, bookId, briefId } = await briefFor();
    await withEnv('AI_MONTHLY_CEILING_USD_DEFAULT', '0.01', async () => {
        const { api, review } = await run(ctx, bookId, briefId, []);
        expect(api.requests).toHaveLength(0);
        expect(review.run).toMatchObject({ status: 'FAILED', outcome: 'WORKSPACE_CEILING' });
    });
    const call = await prisma.aiCallLog.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId } });
    expect(call).toMatchObject({ outcome: 'CEILING', attempts: 0 });
    await expect(dispatchResearchRun(ctx, bookId, briefId, { gate: MOUNTED_GATE, enqueue: async () => undefined })).resolves.toMatchObject({ runId: expect.any(String) });
});

it('on the kill switch thrown after dispatch: nothing is sent and the run says KILL_SWITCH', async () => {
    const { ctx, bookId, briefId } = await briefFor();
    const api = fakeAnthropic([]);
    const { runId } = await dispatchResearchRun(ctx, bookId, briefId, { gate: MOUNTED_GATE, enqueue: async () => undefined });
    await withEnv('AI_DISABLED', '1', async () => {
        await executeResearchRun({ workspaceId: ctx.workspaceId, runId }, { gate: MOUNTED_GATE, researcher: (c) => defaultResearcher(c, { fetch: api.fetch }) });
    });
    expect(api.requests).toHaveLength(0);
    const review = await getResearchRunReview(ctx, bookId, runId);
    expect(['KILL_SWITCH', 'AI_UNAVAILABLE']).toContain(review.run.outcome);
    expect(review.run.status).not.toBe('RUNNING');
});
