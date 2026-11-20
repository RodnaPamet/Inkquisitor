/**
 * Latency of the first question (Phase 2.H item 4), measured as COUNTED WORK
 * rather than a wall clock: a wall-clock bound measures the machine CI ran on,
 * and has flaked here before. What the 3-second p95 depends on is what a
 * request does before the author sees something, and that is countable:
 *
 *   • the first event (`started`) and the round's targets (`planned`) are on
 *     the wire before ANY model call is made — the page shows the interview
 *     and the fields it will ask about at once;
 *   • the first question (`draft`) follows exactly ONE generation call, however
 *     many personas the round has (each persona's call streams its drafts as
 *     it returns, never after the whole round): the first question waits for
 *     one balanced-tier call, not three;
 *   • and a bounded number of database transactions, held to the count the
 *     design needs so that a new read on the path to the first question fails
 *     here.
 *
 * Run against the stubbed model (D13), through the real 2.1 path: the client,
 * its middleware, `callStructured` and the ledger. Nothing reaches a network.
 */
import { prisma } from '@/lib/db';
import * as rls from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { startInterview } from '@/app-layer/usecases/interviews';
import { defaultQuestionGenerator } from '@/lib/interview/model-seam';
import type { QuestionGenerator } from '@/lib/interview/generator';
import type { InterviewStreamEvent } from '@/lib/interview/stream-events';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

/**
 * Transactions a streamed start opens before its first question, as measured
 * on 2026-11-20: the start and claim (the session written, the round claimed),
 * then 2.1's reservation and its settlement around the one call. Raise it only
 * with a reason: each is a database round trip the author waits on.
 */
const TRANSACTIONS_BEFORE_FIRST_QUESTION_MAX = 3;

const before = { ...process.env };
afterEach(() => {
    for (const key of ['AI_MODEL_STUB', 'ANTHROPIC_API_KEY']) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
    }
    jest.restoreAllMocks();
});

it('the first event and the targets precede every model call; the first question follows ONE call of several, and a bounded number of transactions', async () => {
    const owner = await createAccount();
    const ctx = workspaceCtx(owner);
    const bookId = (await createBook(ctx, { title: 'The Long Thaw' })).id;
    const elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ilse' })).id;

    process.env.AI_MODEL_STUB = '1';
    delete process.env.ANTHROPIC_API_KEY;
    const real = defaultQuestionGenerator(ctx);
    let callsStarted = 0;
    let callsFinished = 0;
    const generator: QuestionGenerator = {
        unavailableReason: () => real.unavailableReason(),
        async generateCandidates(request, signal) {
            callsStarted++;
            try {
                return await real.generateCandidates(request, signal);
            } finally {
                callsFinished++;
            }
        },
    };
    const tx = jest.spyOn(rls, 'runInWorkspaceContext');
    const log: Array<{ type: InterviewStreamEvent['type']; callsStarted: number; callsFinished: number; transactions: number }> = [];
    const view = await startInterview(
        ctx,
        bookId,
        { scope: 'ELEMENT', elementId, depth: 2, detail: 3, personaKeys: ['gentle-mentor', 'socratic', 'ruthless-editor'] },
        {
            generator,
            embedder: null,
            stream: {
                emit: (e) => log.push({ type: e.type, callsStarted, callsFinished, transactions: tx.mock.calls.length }),
                ready: () => undefined,
            },
        },
    );

    expect(view.round?.questions.length ?? 0).toBeGreaterThan(0);
    // A persona with a share of the round's targets makes a call: more than one here.
    expect(callsStarted).toBeGreaterThanOrEqual(2);
    const first = (type: InterviewStreamEvent['type']) => log.find((e) => e.type === type)!;
    expect(first('started')).toMatchObject({ callsStarted: 0 });
    expect(first('planned')).toMatchObject({ callsStarted: 0 });
    const draft = first('draft');
    expect(draft).toMatchObject({ callsStarted: 1, callsFinished: 1 });
    expect(draft.transactions).toBeLessThanOrEqual(TRANSACTIONS_BEFORE_FIRST_QUESTION_MAX);
    // And the committed round arrives after the last call, as one transaction more.
    expect(first('committed')).toBeUndefined(); // `committed` is the transport's (stream-response.ts), not the usecase's
    expect(log.filter((e) => e.type === 'draft').length).toBeGreaterThanOrEqual(callsStarted);
});
