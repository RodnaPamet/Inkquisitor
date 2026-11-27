/**
 * NO AUTHOR TEXT IN ANY SINK (Phase 2.H, roadmap item 6; rule 4).
 *
 * A marker word is planted in every kind of author text the product takes —
 * a book's title and logline, an element's name, summary and fields, a
 * relation's note and (Phase 3.3) its fields, a concept note, an interview answer, the reconcile step's
 * proposals, a rephrase, a research brief, an attached file, a fetched page
 * and its findings, a model answer that fails validation, and an unexpected
 * error whose message carries it, (Phase 5.1) a manuscript's titles, a scene's text, story time and note, an
 * import's file and a research note on a scene, (Phase 5.2) a scene's prose check, its notes and a style sheet's
 * words, a model-call rate-limit refusal of a
 * request about it, and a word search for it (Phase 3.4: the query, and the
 * snippets that quote it back, answered and refused — through its route with
 * a real body: a malformed one, a member past its raw bound, each of the
 * parser's refusals, and a rate-limited one) — through the product's own usecases, the
 * model layer (over the fake Messages API) and the request wrapper. Then every
 * sink is read: every log line the logger was handed (as the redacting
 * formatter would write it, and as it was handed), every span an in-memory
 * OpenTelemetry exporter received (names, attributes, events, status), every
 * event handed to Sentry (the error, its scope's tags and user), every
 * `AiCallLog` row of the workspace (all columns) and every audit row's
 * details. The marker is in none of them.
 */
const sentry = { captured: [] as unknown[], tags: [] as Array<[string, string]>, users: [] as unknown[] };
jest.mock('@sentry/nextjs', () => ({
    init: jest.fn(),
    getClient: () => ({}),
    close: jest.fn(async () => true),
    withScope: (cb: (scope: unknown) => void) =>
        cb({
            setTag: (k: string, v: string) => sentry.tags.push([k, v]),
            setUser: (u: unknown) => sentry.users.push(u),
        }),
    captureException: (err: unknown) => {
        sentry.captured.push(err);
        return 'evt';
    },
}));
// The session seam (`auth()`), for the routes called with a real request below (word search's route, Phase 3.4).
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

import { NextRequest } from 'next/server';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { prisma } from '@/lib/db';
import { getGapHuntPage, runGapHunt } from '@/app-layer/usecases/gap-hunts';
import { defaultGapRanker } from '@/lib/gap-hunt/model-seam';
import { defaultStressTester } from '@/lib/stress-test/model-seam';
import { MOUNTED as MOUNTED_INTERROGATION, runStressTest } from '../helpers/interrogation';
import { saveStoryMap } from '@/app-layer/usecases/story-maps';
import { searchBook } from '@/app-layer/usecases/book-search';
import { POST as searchRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/search/route';
import { enforceRateLimit } from '@/lib/security/rate-limit-middleware';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { pinoInstance } from '@/lib/observability/logger';
import { redactLogObject } from '@/lib/observability/redaction';
import { _resetSentryForTests, initSentry } from '@/lib/observability/sentry';
import { withApiErrorHandling } from '@/lib/errors/api';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { addRelation, saveRelationFields } from '@/app-layer/usecases/bible-relations';
import { importConceptNote } from '@/app-layer/usecases/bible-import';
import { callStructured } from '@/app-layer/usecases/model-calls';
import { closeRound, getInterview, nextRound, startInterview } from '@/app-layer/usecases/interviews';
import { defaultRoundsSummarizer } from '@/lib/interview/compaction-seam';
import { defaultQuestionOrderer } from '@/lib/interview/question-order/model-seam';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { rephraseQuestion } from '@/app-layer/usecases/interview-rephrase';
import { chargeModelCalls, MODEL_CALLS_LIMIT } from '@/lib/security/model-call-rate-limit';
import { closeRoundAndReconcile } from '@/app-layer/usecases/enrichment-reconcile';
import { attachResearchSource, createResearchBrief, dispatchResearchRun } from '@/app-layer/usecases/research-briefs';
import { executeResearchRun } from '@/app-layer/usecases/research-run';
import { acceptResearchProposal } from '@/app-layer/usecases/research-review';
import { createChapter, createScene } from '@/app-layer/usecases/manuscript';
import { restoreSceneVersion, saveSceneNote, saveSceneText, updateSceneMeta } from '@/app-layer/usecases/manuscript-scenes';
import { executeProseCheck } from '@/app-layer/usecases/prose-check-run';
import { dismissProseFinding, getSceneProseChecks, saveProseCheckSettings } from '@/app-layer/usecases/prose-checks';
import { confirmManuscriptImport, previewManuscriptImport } from '@/app-layer/usecases/manuscript-import';
import { reconcilerOver } from '@/lib/enrichment/model-seam';
import { RECONCILE_PROMPT } from '@/lib/enrichment/prompt';
import { questionGeneratorOver } from '@/lib/interview/model-seam';
import { defaultResearcher } from '@/lib/research/model-seam';
import { stubReconcileAnswer } from '@/lib/ai/model-stub';
import { fakeAnthropic, setFakeApiKey, type FakeTurn } from '../helpers/fake-anthropic';
import { questionModelAnswer, systemOf } from '../helpers/fake-question-model';
import { stubQuestionEmbedder } from '../helpers/interview';
import { CLEAN_SCAN, gatherEvents, MOUNTED_GATE } from '../helpers/research';
import { createAccount, workspaceCtx } from '../helpers/workspaces';
import { makeDocx } from '../helpers/source-files';
import { dispatchIngestion, uploadSource } from '@/app-layer/usecases/source-library';
import { executeSourceIngest } from '@/app-layer/usecases/source-ingest';
import { decideFact, listBookFacts, setFactOverride } from '@/app-layer/usecases/source-facts';
import { defaultFactExtractor } from '@/lib/sources/model-seam';
import { defaultBibleFactExtractor } from '@/lib/facts/model-seam';
import { executeFactLayerDispatch } from '@/app-layer/usecases/fact-layer-dispatch';
import { extractPending } from '../helpers/facts';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { createThread, decideThreadProposal, getContinuityPage, updateThread } from '@/app-layer/usecases/continuity';
import { decideFactProposal } from '@/app-layer/usecases/fact-proposals';
import { runNight } from '../helpers/continuity';

/** One word that appears nowhere but in author text: any sink holding it holds author text. */
const MARKER = 'Zyxquorblemarkh';
const marked = (s: string) => `${s} ${MARKER}`;

const logged: unknown[] = [];
const exporter = new InMemorySpanExporter();
let provider: TracerProvider;
let undoKey: () => void;
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

beforeAll(async () => {
    undoKey = setFakeApiKey();
    provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
    for (const level of LEVELS) {
        jest.spyOn(pinoInstance, level).mockImplementation(((...args: unknown[]) => {
            logged.push(args);
        }) as never);
    }
    process.env.SENTRY_DSN = 'https://public@sentry.example.test/1';
    _resetSentryForTests();
    await initSentry();
});

afterAll(async () => {
    undoKey();
    delete process.env.SENTRY_DSN;
    _resetSentryForTests();
    jest.restoreAllMocks();
    await provider.shutdown();
    trace.disable();
    context.disable();
    await prisma.$disconnect();
});

/** Every sink, as text. */
async function sinks(workspaceId: string): Promise<Record<string, string>> {
    const spans = exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status }));
    const calls = await prisma.$queryRaw<unknown[]>`SELECT * FROM "AiCallLog" WHERE "workspaceId" = ${workspaceId}`;
    const audit = await prisma.$queryRaw<Array<{ details: unknown }>>`SELECT "detailsJson" AS details, "action", "entityType" FROM "AuditLog" WHERE "workspaceId" = ${workspaceId}`;
    const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    return {
        'logs (as written, after the redacting formatter)': JSON.stringify(logged.map((args) => (Array.isArray(args) ? args.map((a) => (a && typeof a === 'object' ? redactLogObject(a) : a)) : args))),
        'logs (as handed to the logger)': JSON.stringify(logged),
        'OpenTelemetry spans': JSON.stringify(spans),
        Sentry: JSON.stringify({ captured: sentry.captured.map((e) => (e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e)), tags: sentry.tags, users: sentry.users }),
        AiCallLog: JSON.stringify(calls, replacer),
        'audit details': JSON.stringify(audit, replacer),
    };
}

const PAGE = { url: 'https://lighthouses.example.org/keepers', title: 'Keepers', text: `Lighthouse keepers trimmed the wick every four hours through the night, ${MARKER} or not.` };

it('a marker planted in every author-text path reaches no log line, span, Sentry event, AiCallLog row or audit detail', async () => {
    const owner = await createAccount({ workspaceName: 'Privacy sinks' });
    const ctx = workspaceCtx(owner);

    // The bible: a book, elements, fields, a relation note, a concept note — through the request wrapper.
    const wrapped = <T,>(fn: () => Promise<T>) => withApiErrorHandling(async () => Response.json(await fn()))(new NextRequest('http://localhost/api/w/x/books', { method: 'POST' }), {});
    const bookRes = await wrapped(() => createBook(ctx, { title: marked('The Lamp'), logline: marked('A keeper alone') }));
    const bookId = ((await bookRes.json()) as { id: string }).id;
    const ilse = await createElement(ctx, bookId, { kind: 'CHARACTER', name: marked('Ilse'), summary: marked('A keeper'), fields: [{ key: 'role', value: marked('Keeper of the light.') }] });
    const light = await createElement(ctx, bookId, { kind: 'SETTING', name: 'The Wennaway Light', fields: [{ key: 'place_type', value: 'A lighthouse on a tidal island.' }] });
    await updateElementFields(ctx, bookId, ilse.id, { baseVersion: 1, fields: [{ key: 'want', value: marked('To keep the light burning.') }] });
    const lives = await addRelation(ctx, bookId, { fromElementId: ilse.id, toElementId: light.id, type: 'related_to', note: marked('She lives there.') });
    // A relation's fields (Phase 3.3, D24): saved, and refused over a newer version — through the request wrapper.
    await wrapped(() => saveRelationFields(ctx, bookId, lives.id, { baseVersion: 1, fields: [{ key: 'nature', value: marked('She was born in its lamp room.') }], changeSummary: marked('Why') }));
    const staleRelation = await wrapped(() => saveRelationFields(ctx, bookId, lives.id, { baseVersion: 1, fields: [{ key: 'significance', value: marked('It is all she has.') }] }));
    expect(staleRelation.status).toBe(409);
    expect((await staleRelation.text()).toLowerCase()).not.toContain(MARKER.toLowerCase());
    await importConceptNote(ctx, bookId, { text: marked('A note about tides and lamps.') }, { scan: CLEAN_SCAN });

    // The story canvas (Phase 3.1): a sticky note on the relationship map, saved through the request wrapper, and a refused layer.
    await wrapped(() =>
        saveStoryMap(ctx, bookId, 'relationship', {
            expectedVersion: 0,
            nodes: [{ elementId: ilse.id, x: 0, y: 0, w: 220, h: 88, lane: null }],
            edges: [],
            freeform: [{ id: 'shape:note1', typeName: 'shape', type: 'note', x: 0, y: 0, props: { text: marked('Ilse sees the ship') } }],
        }),
    );
    const refusedLayer = await wrapped(() => saveStoryMap(ctx, bookId, 'relationship', { expectedVersion: 1, nodes: [], edges: [], freeform: [{ id: 'shape:x', typeName: 'shape', type: 'story-node', props: { text: marked('refused') } }] }));
    expect(refusedLayer.status).toBe(400);

    // Word search (Phase 3.4): the query is author text and so are the snippets it answers with — through the
    // request wrapper, answered and refused (a query past its word bound echoes nothing back).
    const searched = await wrapped(() => searchBook(ctx, bookId, { q: `${MARKER} keeper` }));
    expect(searched.status).toBe(200);
    expect(await searched.text()).toContain(MARKER);
    const refusedSearch = await wrapped(() => searchBook(ctx, bookId, { q: `${MARKER} a b c d e f g h i j k l` }));
    expect(refusedSearch.status).toBe(400);
    expect((await refusedSearch.text()).toLowerCase()).not.toContain(MARKER.toLowerCase());
    // And through the route itself, with real request bodies: the body reader, the request schema and the
    // rate limit each refuse a body carrying the marker, and none of their answers echoes it.
    session.userId = owner.userId;
    try {
        const ip = '198.51.100.77';
        const search = (body: string) =>
            searchRoute(new NextRequest(`http://localhost/api/w/${owner.workspaceSlug}/books/${bookId}/search`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip } }), {
                params: Promise.resolve({ workspaceSlug: owner.workspaceSlug, bookId }),
            });
        const answered = await search(JSON.stringify({ q: `${MARKER} keeper` }));
        expect(answered.status).toBe(200);
        expect(await answered.text()).toContain(MARKER);
        const refusals: Array<[string, string, string]> = [
            ['malformed JSON', `{"q": "${MARKER} keeper`, 'BODY_NOT_JSON'],
            ['past the raw bound', JSON.stringify({ q: `${MARKER} ${'x'.repeat(900)}` }), 'VALIDATION_ERROR'],
            ['past the trimmed bound', JSON.stringify({ q: `${MARKER} ${'y'.repeat(250)}` }), 'QUERY_TOO_LONG'],
            ['too many words', JSON.stringify({ q: `${MARKER} a b c d e f g h i j k l` }), 'QUERY_TOO_MANY_TERMS'],
            ['too many phrases', JSON.stringify({ q: `"${MARKER} a" "b c" "d e" "f g" "h i"` }), 'QUERY_TOO_MANY_PHRASES'],
            ['not a string', JSON.stringify({ q: [MARKER] }), 'VALIDATION_ERROR'],
        ];
        for (const [label, body, code] of refusals) {
            const res = await search(body);
            const text = await res.text();
            expect([label, res.status, text.includes(code), text.toLowerCase().includes(MARKER.toLowerCase())]).toEqual([label, 400, true, false]);
        }
        process.env.RATE_LIMIT_ENABLED = '1';
        try {
            const probe = new NextRequest('http://localhost/', { headers: { 'x-forwarded-for': ip } });
            for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) enforceRateLimit(probe, { config: API_READ_LIMIT, scope: 'book-search' });
            const limitedSearch = await search(JSON.stringify({ q: `${MARKER} keeper` }));
            expect(limitedSearch.status).toBe(429);
            expect((await limitedSearch.text()).toLowerCase()).not.toContain(MARKER.toLowerCase());
        } finally {
            delete process.env.RATE_LIMIT_ENABLED;
        }
    } finally {
        session.userId = null;
    }

    // An unexpected error carrying author text, through the wrapper: logged, traced and reported, its message withheld.
    const failed = await withApiErrorHandling(async () => {
        throw new Error(marked('Ilse failed'));
    })(new NextRequest('http://localhost/api/w/x/books/b/elements?q=' + MARKER, { method: 'POST' }), {});
    expect(failed.status).toBe(500);

    // An interview: generation, an answer, a rephrase, a reconcile whose proposals carry the answer's words,
    // and a model answer that fails validation twice while quoting the marker.
    const api = fakeAnthropic([
        {
            kind: 'repeat',
            turn: {
                kind: 'respond',
                answer: (body) => {
                    const system = systemOf(body);
                    if (system.includes(RECONCILE_PROMPT.system.slice(0, 80))) return { kind: 'text', text: JSON.stringify(stubReconcileAnswer(body)) };
                    return questionModelAnswer(body);
                },
            },
        } satisfies FakeTurn,
    ]);
    const generator = questionGeneratorOver((input) => callStructured(ctx, input, { fetch: api.fetch }));
    const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: ilse.id, depth: 2, detail: 3 }, { generator, embedder: stubQuestionEmbedder });
    const q = view.round!.questions.find((x) => x.kind === 'OPEN' || x.kind === 'SCENARIO') ?? view.round!.questions[0];
    await rephraseQuestion(ctx, bookId, view.session.id, q.id, { generator, embedder: stubQuestionEmbedder }).catch(() => undefined);
    // The workspace's model-call rate limit (2.H, issue #32 item 5) refusing a request about author text, through
    // the wrapper: a 429 naming a code, its body and every sink without the marker. The limits are off in tests
    // unless switched on, as here, for this request alone.
    const limited = (await getInterview(ctx, bookId, view.session.id)).round!.questions.find((x) => x.id !== q.id && x.answer === null)!;
    process.env.RATE_LIMIT_ENABLED = '1';
    try {
        chargeModelCalls(ctx.workspaceId, MODEL_CALLS_LIMIT.maxAttempts);
        const refused = await withApiErrorHandling(async () =>
            Response.json(await rephraseQuestion(ctx, bookId, view.session.id, limited.id, { generator, embedder: stubQuestionEmbedder })),
        )(new NextRequest('http://localhost/api/w/x/books/b/interviews/s/questions/q/rephrase', { method: 'POST' }), {});
        expect(refused.status).toBe(429);
        const refusal = await refused.text();
        expect(refusal).toContain('MODEL_RATE_LIMITED');
        expect(refusal.toLowerCase()).not.toContain(MARKER.toLowerCase());
    } finally {
        delete process.env.RATE_LIMIT_ENABLED;
    }
    for (const question of (await getInterview(ctx, bookId, view.session.id)).round!.questions) {
        const body = question.kind === 'CHOICE' || question.kind === 'EITHER_OR' ? { choice: question.options![0] } : question.kind === 'SCALE' ? { scale: 3 } : { text: marked('She fears the dark water.') };
        await answerQuestion(ctx, bookId, view.session.id, question.id, body).catch(() => undefined);
    }
    const reconciler = reconcilerOver((input) => callStructured(ctx, input, { fetch: api.fetch }));
    await closeRoundAndReconcile(ctx, bookId, view.session.id, String(view.round!.number), { skipUnanswered: true }, { reconciler });
    const invalid = fakeAnthropic([
        { kind: 'text', text: JSON.stringify({ questions: [{ text: MARKER }], declined: MARKER }) },
        { kind: 'text', text: JSON.stringify({ wrong: MARKER }) },
    ]);
    await questionGeneratorOver((input) => callStructured(ctx, input, { fetch: invalid.fetch })).generateCandidates({ ...(await firstRequestOf()), bookId } as never);

    // Research: a brief, an attached file, a fetched page, findings quoting both.
    const brief = await createResearchBrief(ctx, bookId, { question: 'What did lighthouse keepers do each night?', purpose: marked('My character needs believable routines'), scopeElementIds: [light.id], depth: 'QUICK' });
    await attachResearchSource(ctx, bookId, brief.id, { bytes: new TextEncoder().encode(`Keepers logged every ship ${MARKER}.`), mediaType: 'text/plain', filename: 'notes.txt' }, { scan: CLEAN_SCAN });
    const web = fakeAnthropic([
        { kind: 'events', events: gatherEvents({ query: 'lighthouse keepers night routine', pages: [PAGE] }) },
        {
            kind: 'text',
            text: JSON.stringify({
                findings: [{ claim: `Lighthouse keepers trimmed the wick every four hours through the night.`, summary: `Lighthouse keepers trimmed the wick every four hours through the night.`, confidence: 'HIGH', citations: [{ ref: 'web.1', quote: `Lighthouse keepers trimmed the wick every four hours through the night, ${MARKER} or not.` }] }],
            }),
        },
        { kind: 'text', text: JSON.stringify({ proposals: [], noFit: [{ finding: 'f1', reason: marked('Nothing fits') }] }) },
    ]);
    const { runId } = await dispatchResearchRun(ctx, bookId, brief.id, { gate: MOUNTED_GATE, enqueue: async () => undefined });
    await executeResearchRun({ workspaceId: ctx.workspaceId, runId }, { gate: MOUNTED_GATE, researcher: (c) => defaultResearcher(c, { fetch: web.fetch }) });

    // Book-level interrogation (Phase 4.3, D29): a stress test over the canon (which carries the marker) whose
    // weak point quotes it back; a gap hunt ranked by a model that names it; the stored text is encrypted, and
    // nothing of it reaches a sink.
    const stressApi = fakeAnthropic([
        { kind: 'respond', answer: (body) => ({ kind: 'text', text: JSON.stringify({ weakPoints: [{ kind: 'OTHER', title: `The keeper ${MARKER}`, questions: [`What does the keeper ${MARKER} want?`], cites: [/(E\d+)\. \[CHARACTER\]/.exec(JSON.stringify(body.messages))![1]] }] }) }) },
    ]);
    const stress = await runStressTest(ctx, bookId, { tester: (c) => defaultStressTester(c, { fetch: stressApi.fetch }) });
    expect(stress.outcome).toBe('OK');
    {
        const restore = setFakeApiKey();
        try {
            const page = await getGapHuntPage(ctx, bookId, { gate: MOUNTED_INTERROGATION });
            // The ranking call MUST be made here: a page that could not rank would plant nothing in the path.
            if (!page.ranking.available) throw new Error(`the gap ranking was not available (${page.ranking.reason})`);
            const first = page.hunt.candidates[0];
            const rankApi = fakeAnthropic([{ kind: 'text', text: JSON.stringify({ picks: [{ candidate: first.n, reason: `${first.fieldLabel} matters for ${MARKER}.`, cites: [first.n] }] }) }]);
            const ranked = await runGapHunt(ctx, bookId, { confirmWorstCaseMicroUsd: page.ranking.worstMicroUsd }, { gate: MOUNTED_INTERROGATION, charge: () => undefined, ranker: (c) => defaultGapRanker(c, { fetch: rankApi.fetch }) });
            expect(rankApi.requests).toHaveLength(1);
            expect(ranked.ranked).toBe(true);
        } finally {
            restore();
        }
    }

    // Long-session compaction (Phase 4.3, D29; off by default, on here): a session whose answers carry the marker,
    // its earlier rounds summarised through the real seam by a model that names the marker; the summary is stored
    // encrypted and reaches no sink.
    {
        const restore = setFakeApiKey();
        try {
            const summaryApi = fakeAnthropic([{ kind: 'repeat', turn: { kind: 'text', text: JSON.stringify({ summary: `The questions covered what the keeper wants and fears (${MARKER}).` }) } }]);
            const compacting = { generator: fakeGenerator(), embedder: stubQuestionEmbedder, compaction: { enabled: true, thresholdChars: 10 }, summarizer: (c: typeof ctx) => defaultRoundsSummarizer(c, { fetch: summaryApi.fetch }), charge: () => undefined };
            const keeper = await createElement(ctx, bookId, { kind: 'CHARACTER', name: marked('Bram'), summary: marked('The relief keeper') });
            let long = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: keeper.id, depth: 5, detail: 3 }, compacting);
            for (let round = 1; round <= 2; round++) {
                for (const question of long.round!.questions) await answerQuestion(ctx, bookId, long.session.id, question.id, { text: marked(`Round ${round}: he keeps a tide table.`) }).catch(() => undefined);
                await closeRound(ctx, bookId, long.session.id, String(long.round!.number), { skipUnanswered: true });
                long = await nextRound(ctx, bookId, long.session.id, compacting);
            }
            expect(summaryApi.requests).toHaveLength(1);
            const stored = await prisma.$queryRawUnsafe<Array<{ summary: string }>>('SELECT "summary" FROM "InterviewCompaction" WHERE "sessionId" = $1', long.session.id);
            expect(stored).toHaveLength(1);
            expect(stored[0].summary.startsWith('v2:')).toBe(true);
        } finally {
            restore();
        }
    }

    // The interview's tie-break (Phase 4.4, D30): near-equal candidates whose element names carry the marker, ordered
    // through the real seam by a model; the call's request carries the names (fenced data) and nothing reaches a sink.
    {
        const restore = setFakeApiKey();
        try {
            const orderApi = fakeAnthropic([
                {
                    kind: 'respond',
                    answer: (body) => {
                        const n = (JSON.stringify(body.messages).match(/\\n\d+\. \[/g) ?? []).length;
                        return { kind: 'text', text: JSON.stringify({ order: Array.from({ length: n }, (_, i) => n - i) }) };
                    },
                },
            ]);
            const tieBook = (await createBook(ctx, { title: 'Ties' })).id;
            await createElement(ctx, tieBook, { kind: 'CHARACTER', name: marked('Ada') });
            await createElement(ctx, tieBook, { kind: 'CHARACTER', name: marked('Bram') });
            const tied = await startInterview(
                ctx,
                tieBook,
                { scope: 'KIND', kind: 'CHARACTER', depth: 2, detail: 3, generatorsOff: ['LADDER', 'RELATIONS', 'SOURCES', 'CONTINUITY'] },
                { generator: fakeGenerator(), embedder: stubQuestionEmbedder, orderer: (c) => defaultQuestionOrderer(c, { fetch: orderApi.fetch }), charge: () => undefined },
            );
            expect(orderApi.requests).toHaveLength(1);
            expect(JSON.stringify(orderApi.requests[0])).toContain(MARKER);
            const round = await prisma.interviewRound.findFirstOrThrow({ where: { sessionId: tied.session.id }, select: { metrics: true } });
            expect((round.metrics as { order?: { status?: string } }).order?.status).toBe('MODEL');
        } finally {
            restore();
        }
    }

    // Sources (Phase 4.0): a DOCX whose name and text carry the marker, read into chunks, its
    // facts drawn by a model that quotes it, a second chunk answered with marker-laden invalid output.
    const draft = makeDocx([{ heading: marked('Chapter') }, { para: `Light wants to keep the lamp burning ${MARKER} all winter.` }]);
    const src = await uploadSource(ctx, { kind: 'series' }, { bytes: draft, filename: marked('draft') + '.docx' }, { scan: CLEAN_SCAN });
    await dispatchIngestion(ctx, src.id, { confirmWorstCaseMicroUsd: src.worstCaseMicroUsd }, { enqueue: async () => undefined });
    const extraction = fakeAnthropic([
        { kind: 'text', text: JSON.stringify({ facts: [{ subject: 'Light', predicate: 'WANT', object: MARKER, statement: `Light wants to keep the lamp burning ${MARKER} all winter.`, quote: `Light wants to keep the lamp burning ${MARKER} all winter.`, storyTimeFrom: '', storyTimeTo: '' }] }) },
    ]);
    const ingested = await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: src.id }, { extractor: (c) => defaultFactExtractor(c, { fetch: extraction.fetch }), embedder: () => new StubEmbeddingProvider() });
    expect(ingested.outcome).toBe('OK');
    const sourceFacts = await listBookFacts(ctx, bookId);
    expect(sourceFacts.facts).toHaveLength(0);
    const { setSeriesOptIn } = await import('@/app-layer/usecases/source-library');
    await setSeriesOptIn(ctx, bookId, src.id, true);
    const drawn = (await listBookFacts(ctx, bookId)).facts[0];
    expect(drawn.statement).toContain(MARKER);
    await decideFact(ctx, drawn.id, 'CONFIRM');
    await setFactOverride(ctx, bookId, drawn.id, { text: marked('Our own answer') });
    const invalidSource = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode(`Light keeps a ${MARKER} journal of every ship.`), filename: 'log.txt' }, { scan: CLEAN_SCAN });
    await dispatchIngestion(ctx, invalidSource.id, { confirmWorstCaseMicroUsd: invalidSource.worstCaseMicroUsd }, { enqueue: async () => undefined });
    const broken = fakeAnthropic([{ kind: 'repeat', turn: { kind: 'text', text: JSON.stringify({ wrong: MARKER }) } }]);
    await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: invalidSource.id }, { extractor: (c) => defaultFactExtractor(c, { fetch: broken.fetch }), embedder: () => new StubEmbeddingProvider() });

    // Bible facts (Phase 4.1, D27): every accepted version extracted by a model that quotes the marker back
    // (the facts stored, encrypted), then elements, facts and answers embedded in the background.
    const bibleModel = fakeAnthropic([
        {
            kind: 'repeat',
            turn: {
                kind: 'text',
                text: JSON.stringify({
                    facts: [{ subject: marked('Ilse'), predicate: 'WANT', object: MARKER, statement: `${marked('Ilse')} wants to keep the light burning.`, quote: marked('To keep the light burning.'), storyTimeFrom: '', storyTimeTo: '', contradicts: [] }],
                    // Phase 4.2 (D28): a thread proposed from the entry, its title and quote carrying the marker.
                    threads: [{ kind: 'PROMISE', title: marked('To keep the light burning'), quote: marked('To keep the light burning.'), paysOff: 0 }],
                }),
            },
        },
    ]);
    const extracted = await extractPending(ctx, bookId, () => defaultBibleFactExtractor(ctx, { fetch: bibleModel.fetch }));
    expect(extracted).toContain('OK');
    expect(await prisma.storyFact.count({ where: { bookId, sourceKind: 'BIBLE_VERSION' } })).toBeGreaterThan(0);
    const embedded = await executeFactLayerDispatch({ extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });
    expect(embedded).toMatchObject({ embedFailed: 0 });
    expect(embedded.embedded).toBeGreaterThan(0);

    // Continuity (Phase 4.2, D28): the proposed thread accepted, a thread by hand and its edit, a contradiction kept
    // both with an explanation, a stale flag dismissed, the nightly check read over the marked facts, the page read.
    const threadPage = await getContinuityPage(ctx, bookId);
    expect(threadPage.threadProposals.items.length).toBeGreaterThan(0);
    await decideThreadProposal(ctx, bookId, threadPage.threadProposals.items[0].id, { decision: 'ACCEPT' });
    const handThread = await createThread(ctx, bookId, { kind: 'CLUE', title: marked('A wet boot'), note: marked('Planted early') });
    await updateThread(ctx, bookId, handThread.id, { baseVersion: 1, title: marked('A wet boot by the door') });
    // A second live fact beside the extracted one: its row copied in SQL (its sealed text with it), its claim key its own (64 hex, the key's shape).
    const extractedFact = await prisma.storyFact.findFirstOrThrow({ where: { bookId, sourceKind: 'BIBLE_VERSION' }, select: { id: true } });
    const factColumns = (await prisma.$queryRaw<Array<{ name: string }>>`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'StoryFact'`)
        .map((c) => c.name)
        .filter((c) => !['id', 'dedupeKey', 'createdAt'].includes(c));
    const columnList = factColumns.map((c) => `"${c}"`).join(', ');
    await prisma.$executeRawUnsafe(`INSERT INTO "StoryFact" ("id", "dedupeKey", ${columnList}) SELECT $1, md5("dedupeKey") || md5("id"), ${columnList} FROM "StoryFact" WHERE "id" = $2`, `${extractedFact.id}x`, extractedFact.id);
    // The manuscript (Phase 5.1, D33): a chapter, a scene and its title, text, story time and note, a stale save, a
    // restore, an import (preview and confirm) — through the request wrapper — and a research brief scoped to the
    // chapter whose fit step reads the scene's opening and proposes a note, accepted.
    const chapterRes = await wrapped(() => createChapter(ctx, bookId, { title: marked('The storm') }));
    const chapterId = ((await chapterRes.json()) as { id: string }).id;
    const sceneId = (await createScene(ctx, bookId, { chapterId, title: marked('The lamp room') })).id;
    await wrapped(() => saveSceneText(ctx, bookId, sceneId, { html: `<p>Ilse climbed to the lamp ${MARKER} at dusk.</p>`, baseRevision: 0, checkpoint: true }));
    const staleScene = await wrapped(() => saveSceneText(ctx, bookId, sceneId, { html: `<p>Lost ${MARKER}</p>`, baseRevision: 0 }));
    expect(staleScene.status).toBe(409);
    expect((await staleScene.text()).toLowerCase()).not.toContain(MARKER.toLowerCase());
    await wrapped(() => updateSceneMeta(ctx, bookId, sceneId, { baseRevision: 1, storyTime: marked('The third night') }));
    await wrapped(() => saveSceneNote(ctx, bookId, sceneId, { note: marked('Check the tide tables.'), baseNoteVersion: 0 }));
    await wrapped(() => restoreSceneVersion(ctx, bookId, sceneId, 1, { baseRevision: 2 }));
    const manuscriptDraft = new TextEncoder().encode(`# ${MARKER} chapter\n\nThe keeper ${MARKER} slept.\n`);
    const previewRes = await wrapped(() => previewManuscriptImport(ctx, bookId, { bytes: manuscriptDraft, filename: `${MARKER}.md` }, { scan: CLEAN_SCAN }));
    const { token, issuedAt, plan } = (await previewRes.json()) as { token: string; issuedAt: number; plan: object };
    const planHeader = Buffer.from(JSON.stringify({ token, issuedAt, ...plan }), 'utf8').toString('base64url');
    expect((await wrapped(() => confirmManuscriptImport(ctx, bookId, { bytes: manuscriptDraft, filename: `${MARKER}.md` }, planHeader, { scan: CLEAN_SCAN }))).status).toBe(200);
    const sceneBrief = await createResearchBrief(ctx, bookId, { question: 'What did lighthouse keepers do each night?', purpose: 'Routines for the storm chapter.', scopeChapterIds: [chapterId], depth: 'QUICK' });
    const sceneWeb = fakeAnthropic([
        { kind: 'events', events: gatherEvents({ query: 'lighthouse keepers night routine', pages: [PAGE] }) },
        {
            kind: 'text',
            text: JSON.stringify({
                findings: [{ claim: 'Lighthouse keepers trimmed the wick every four hours through the night.', summary: 'Lighthouse keepers trimmed the wick every four hours through the night.', confidence: 'HIGH', citations: [{ ref: 'web.1', quote: 'Lighthouse keepers trimmed the wick every four hours through the night' }] }],
            }),
        },
        {
            kind: 'text',
            text: JSON.stringify({ proposals: [{ op: 'SCENE_NOTE', elementId: null, fieldKey: null, value: 'Lighthouse keepers trimmed the wick every four hours through the night.', newKind: null, newName: null, newSummary: null, rationale: marked('The scene is at night'), cites: ['f1'], sceneRef: 's1' }], noFit: [] }),
        },
    ]);
    const sceneRun = await dispatchResearchRun(ctx, bookId, sceneBrief.id, { gate: MOUNTED_GATE, enqueue: async () => undefined });
    await executeResearchRun({ workspaceId: ctx.workspaceId, runId: sceneRun.runId }, { gate: MOUNTED_GATE, researcher: (c) => defaultResearcher(c, { fetch: sceneWeb.fetch }) });
    expect(JSON.stringify(sceneWeb.requests[2])).toContain(MARKER);
    const noteProposal = await prisma.researchProposal.findFirstOrThrow({ where: { runId: sceneRun.runId, operation: 'SCENE_NOTE' }, select: { id: true } });
    await acceptResearchProposal(ctx, bookId, noteProposal.id, {});
    // The prose checks (Phase 5.2, D34): a style sheet whose avoided word and swap are the marker, the scene's check
    // in the worker's usecase, the margin's read through the request wrapper, a dismissal and the settings.
    const sheet = await createElement(ctx, bookId, { kind: 'STYLE', name: marked('House style'), fields: [{ key: 'style_scope', value: 'whole_book' }] });
    await updateElementFields(ctx, bookId, sheet.id, { fields: [{ key: 'avoided_words', value: [MARKER.toLowerCase()] }, { key: 'word_swaps', value: [`dusk → ${MARKER}`] }], baseVersion: sheet.versionNumber });
    expect((await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId })).outcome).toBe('CHECKED');
    const proseRes = await wrapped(() => getSceneProseChecks(ctx, bookId, sceneId));
    const proseView = (await proseRes.json()) as { findings: Array<{ id: string; ruleId: string; params: Record<string, unknown> }> };
    const bannedNote = proseView.findings.find((f) => f.ruleId === 'banned-words');
    expect(bannedNote).toBeDefined();
    await wrapped(() => dismissProseFinding(ctx, bookId, { findingId: bannedNote!.id }));
    await wrapped(() => saveProseCheckSettings(ctx, bookId, { alexEnabled: true, rulesOff: ['wordy'] }));

    const twoFacts = await prisma.storyFact.findMany({ where: { bookId, sourceKind: 'BIBLE_VERSION' }, orderBy: { createdAt: 'asc' }, take: 2, select: { id: true } });
    expect(twoFacts).toHaveLength(2);
    const pr = await prisma.storyFactProposal.create({ data: { workspaceId: ctx.workspaceId, bookId, factId: twoFacts[0].id, newerFactId: twoFacts[1].id, reason: 'CONTRADICTED', basis: 'RULE', kind: 'VALUE' }, select: { id: true } });
    await decideFactProposal(ctx, bookId, pr.id, { decision: 'KEEP_BOTH', explanation: marked('Both hold at different times') });
    await runNight(ctx, { checker: () => ({ extract: async () => ({ ok: true as const, output: { contradictions: [{ first: 1, second: 2, kind: 'OTHER' }] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] as string[] }) }) });
    await getContinuityPage(ctx, bookId);

    // The paths were really taken (a vacuous pass is no pass).
    expect(logged.length).toBeGreaterThan(10);
    expect(exporter.getFinishedSpans().some((s) => s.name === 'api.request')).toBe(true);
    expect(sentry.captured.length).toBeGreaterThan(0);
    expect(await prisma.aiCallLog.count({ where: { workspaceId: owner.workspaceId } })).toBeGreaterThanOrEqual(4);
    expect(await prisma.researchFinding.count({ where: { runId } })).toBe(1);

    const read = await sinks(owner.workspaceId);
    // Each sink is really read (its own words are there): only then does an absent marker mean anything.
    expect(read['logs (as written, after the redacting formatter)']).toContain('request completed');
    expect(read['OpenTelemetry spans']).toContain('api.request');
    expect(read.AiCallLog).toContain('interview.reconcile');
    expect(read.AiCallLog).toContain('interview.rephrase');
    expect(read['audit details']).toContain('BIBLE_ELEMENT_CREATED');
    expect(read['audit details']).toContain('STORY_MAP_SAVED');
    expect(read['audit details']).toContain('SOURCE_INGEST_FINISHED');
    expect(read['audit details']).toContain('STORY_FACT_OVERRIDE_SET');
    expect(read.AiCallLog).toContain('sources.extract-facts');
    expect(read.AiCallLog).toContain('facts.bible-extract');
    expect(read['audit details']).toContain('BIBLE_FACTS_EXTRACTED');
    expect(read['audit details']).toContain('MANUSCRIPT_IMPORTED');
    expect(read['audit details']).toContain('MANUSCRIPT_SCENE_RESTORED');
    expect(read['audit details']).toContain('PROSE_FINDING_DISMISSED');
    expect(read['audit details']).toContain('PROSE_CHECK_SETTINGS_CHANGED');
    expect(read['logs (as written, after the redacting formatter)']).toContain('prose check finished');
    expect(read.Sentry).toContain('Error');
    for (const [sink, text] of Object.entries(read)) {
        expect([sink, text.toLowerCase().includes(MARKER.toLowerCase())]).toEqual([sink, false]);
    }
}, 60_000);

/** A generation request with the marker in its data, as the engine would hand the generator. */
async function firstRequestOf() {
    const { QUESTION_PROMPT } = await import('@/lib/interview/prompt');
    const { GeneratedQuestionsSchema } = await import('@/lib/interview/candidates');
    return { template: QUESTION_PROMPT, data: [{ label: 'element.1', text: marked('Ilse keeps the light.') }], schema: GeneratedQuestionsSchema };
}
