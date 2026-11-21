/**
 * THE SOURCE LIBRARY END TO END (Phase 4.0, D23 and D26), against a real
 * PostgreSQL. The model is the loopback stub (`stubMessagesFetch`) handed to
 * the SDK as its fetch, or a scripted extractor; nothing reaches a network.
 *
 *   upload → chunks (encrypted) → ingest → facts (PENDING) → confirm → the
 *   frontier skips the field; a pending fact never does
 *   the series library: per-book opt-in, provenance, override for one book
 *   isolation: another book, a series source not opted into, another workspace
 *   READER refused every write; bulk confirm only of offered facts
 *   the ceiling stop and its resume; the virus refusal; a changed re-upload
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { startInterview } from '@/app-layer/usecases/interviews';
import { embedderFrom } from '@/app-layer/usecases/question-embeddings';
import { dispatchIngestion, getSource, listBookSources, removeSource, setSeriesOptIn, uploadSource } from '@/app-layer/usecases/source-library';
import { executeSourceIngest } from '@/app-layer/usecases/source-ingest';
import { bulkConfirmFacts, clearFactOverride, decideFact, listBookFacts, listSeriesFacts, setFactOverride } from '@/app-layer/usecases/source-facts';
import { assembleSourceContext } from '@/app-layer/usecases/source-retrieval';
import { getVectorRepository } from '@/app-layer/repositories/vector.repository';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { stubMessagesFetch } from '@/lib/ai/model-stub';
import { AppError, RateLimitedError } from '@/lib/errors/types';
import type { FactExtractor, ExtractResult } from '@/lib/sources/extractor';
import { defaultFactExtractor } from '@/lib/sources/model-seam';
import { frontierOf, loadInterviewState, requireSession, type InterviewView } from '@/app-layer/usecases/interview-state';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { makeDocx } from '../helpers/source-files';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const CLEAN_SCAN = async () => ({ status: 'CLEAN' as const, engine: 'test', durationMs: 1 });
const deps = { scan: CLEAN_SCAN, enqueue: async () => undefined };
const embedder = embedderFrom(new StubEmbeddingProvider());
const stubExtractor = (ctx: Parameters<typeof defaultFactExtractor>[0]) => defaultFactExtractor(ctx, { fetch: stubMessagesFetch as typeof fetch });
const ingestDeps = { extractor: stubExtractor, embedder: () => new StubEmbeddingProvider() };

let undoKey: () => void;
beforeAll(() => {
    undoKey = setFakeApiKey();
});
afterAll(() => undoKey());

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, reason: (err.details as { reason?: unknown } | undefined)?.reason };
        throw err;
    }
    throw new Error('expected a refusal');
}

/** What a started session's frontier asks of `elementId`, and what each already-answered check removed. */
async function frontierFor(ctx: ReturnType<typeof workspaceCtx>, bookId: string, view: InterviewView, elementId: string): Promise<{ asks: string[]; answeredBy: Record<string, string> }> {
    return runInWorkspaceContext(ctx, async (db) => {
        const session = await requireSession(db, ctx, bookId, view.session.id);
        const f = frontierOf(await loadInterviewState(db, ctx, session), 5);
        return {
            asks: f.frontier.filter((e) => e.elementId === elementId).map((e) => e.fieldKey),
            answeredBy: Object.fromEntries(f.answered.filter((a) => a.elementId === elementId).map((a) => [a.fieldKey, a.by])),
        };
    });
}

async function ingest(ctx: ReturnType<typeof workspaceCtx>, sourceId: string, more: Partial<Parameters<typeof executeSourceIngest>[1]> = {}) {
    const source = await getSource(ctx, sourceId);
    await dispatchIngestion(ctx, sourceId, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, deps);
    return executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId }, { ...ingestDeps, ...more });
}

/** A text of `chapters` chapters, each a full chunk, each opening with a fact about Wren. */
function longDraft(chapters: number): Uint8Array {
    const parts: string[] = [];
    for (let i = 1; i <= chapters; i++) {
        parts.push(`Chapter ${i}`, `Wren wants to find the lighthouse keeper number ${i}.`, Array.from({ length: 700 }, (_, k) => `filler${k}`).join(' ') + '.');
    }
    return new TextEncoder().encode(parts.join('\n\n'));
}

describe('a book’s source, from upload to the frontier', () => {
    let ctx: ReturnType<typeof workspaceCtx>;
    let bookId: string;
    let wrenId: string;
    let sourceId: string;

    beforeAll(async () => {
        const owner = await createAccount();
        ctx = workspaceCtx(owner);
        bookId = (await createBook(ctx, { title: 'The Lock Keeper' })).id;
        wrenId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', fields: [{ key: 'role', value: 'The lock keeper’s daughter' }] })).id;
    });

    it('uploads a DOCX into encrypted chunks, with a cost estimate, and sends nothing to a model', async () => {
        const docx = makeDocx([{ heading: 'Chapter 3' }, { para: 'Wren wants to cross the river by spring. Wren never learned to swim.' }]);
        const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: docx, filename: 'draft.docx' }, deps);
        sourceId = source.id;
        expect(source).toMatchObject({ format: 'DOCX', status: 'ESTIMATED', chunkCount: 1, chunksDone: 0, factCount: 0, scope: 'BOOK' });
        expect(source.estimateMicroUsd).toBeGreaterThan(0);
        expect(source.worstCaseMicroUsd).toBeGreaterThan(source.estimateMicroUsd);
        const [raw] = await prisma.$queryRaw<Array<{ text: string; headingPath: string }>>`SELECT "text", "headingPath" FROM "SourceChunk" WHERE "sourceId" = ${sourceId}`;
        expect(raw.text.startsWith('v2:')).toBe(true);
        expect(raw.headingPath.startsWith('v2:')).toBe(true);
        const [name] = await prisma.$queryRaw<Array<{ filename: string }>>`SELECT "filename" FROM "Source" WHERE "id" = ${sourceId}`;
        expect(name.filename.startsWith('v2:')).toBe(true);
    });

    it('refuses the same text twice, and names an ingestion whose cost the author did not confirm', async () => {
        const docx = makeDocx([{ heading: 'Chapter 3' }, { para: 'Wren wants to cross the river by spring. Wren never learned to swim.' }]);
        expect(await refusal(uploadSource(ctx, { kind: 'book', bookId }, { bytes: docx, filename: 'copy.docx' }, deps))).toEqual({ status: 409, reason: 'SOURCE_DUPLICATE' });
        expect((await refusal(dispatchIngestion(ctx, sourceId, { confirmWorstCaseMicroUsd: 1 }, deps))).reason).toBe('ESTIMATE_CHANGED');
    });

    it('a pending fact answers nothing; a confirmed one answers its field, and the interview does not ask it', async () => {
        const result = await ingest(ctx, sourceId);
        expect(result.outcome).toBe('OK');
        const page = await listBookFacts(ctx, bookId);
        const want = page.facts.find((f) => f.predicate === 'WANT');
        expect(want).toMatchObject({ status: 'PENDING', provenance: { scope: 'BOOK', filename: 'draft.docx' }, answers: { elementId: wrenId, fieldKey: 'want' } });
        expect(want!.passage.quote).toBe('Wren wants to cross the river by spring.');
        expect(want!.headingPath).toEqual(['Chapter 3']);
        expect(page.offered.ids).toContain(want!.id);

        const session = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: wrenId, depth: 5, detail: 3 }, { generator: fakeGenerator(), embedder });
        const before = await frontierFor(ctx, bookId, session, wrenId);
        expect(before.asks).toContain('want');
        expect(before.answeredBy.want).toBeUndefined();

        await decideFact(ctx, want!.id, 'CONFIRM');
        const after = await frontierFor(ctx, bookId, session, wrenId);
        expect(after.asks.length).toBeGreaterThan(0);
        expect(after.asks).not.toContain('want');
        expect(after.answeredBy.want).toBe('source-facts');
        // The next round's questions are drawn from that frontier: none asks it.
        const next = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: wrenId, depth: 5, detail: 3 }, { generator: fakeGenerator(), embedder });
        expect(next.round!.questions.flatMap((q) => q.targetsFieldKeys)).not.toContain('want');

        // Rejecting it again puts the field back.
        await decideFact(ctx, want!.id, 'REJECT');
        expect((await frontierFor(ctx, bookId, session, wrenId)).asks).toContain('want');
    });

    it('bulk confirm takes only what the view offered, and only with its token', async () => {
        const page = await listBookFacts(ctx, bookId, { status: 'ALL' });
        const view = { kind: 'book' as const, bookId };
        const pending = page.facts.filter((f) => f.status === 'PENDING').map((f) => f.id);
        const rejected = page.facts.filter((f) => f.status === 'REJECTED').map((f) => f.id);
        expect(pending.length).toBeGreaterThan(0);
        expect(rejected.length).toBeGreaterThan(0);
        // A rejected fact was shown but not offered: naming it is refused, nothing written.
        expect(await refusal(bulkConfirmFacts(ctx, { view, offeredIds: page.offered.ids, issuedAt: page.offered.issuedAt, token: page.offered.token, factIds: [...pending, ...rejected] }))).toEqual({ status: 409, reason: 'FACTS_NOT_OFFERED' });
        // A token for another id set (the client widening its own list) is refused.
        expect(await refusal(bulkConfirmFacts(ctx, { view, offeredIds: [...page.offered.ids, ...rejected], issuedAt: page.offered.issuedAt, token: page.offered.token, factIds: rejected }))).toEqual({ status: 409, reason: 'VIEW_EXPIRED' });
        const done = await bulkConfirmFacts(ctx, { view, offeredIds: page.offered.ids, issuedAt: page.offered.issuedAt, token: page.offered.token, factIds: pending });
        expect(done).toEqual({ confirmed: pending.length, skipped: 0 });
        expect((await listBookFacts(ctx, bookId, { status: 'REJECTED' })).facts.map((f) => f.id)).toEqual(rejected);
    });

    it('a READER reads and is refused every write', async () => {
        const reader = await createBareUser();
        await addMember(ctx.workspaceId, reader.id, 'READER');
        const rctx = workspaceCtx({ userId: reader.id, workspaceId: ctx.workspaceId, workspaceSlug: ctx.workspaceSlug }, 'READER');
        expect((await listBookSources(rctx, bookId)).sources).toHaveLength(1);
        const fact = (await listBookFacts(rctx, bookId, { status: 'ALL' })).facts[0];
        expect((await refusal(uploadSource(rctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode('Notes about Wren and the river.'), filename: 'n.txt' }, deps))).status).toBe(403);
        expect((await refusal(decideFact(rctx, fact.id, 'CONFIRM'))).status).toBe(403);
        expect((await refusal(removeSource(rctx, sourceId))).status).toBe(403);
        expect((await refusal(dispatchIngestion(rctx, sourceId, { confirmWorstCaseMicroUsd: 1e9 }, deps))).status).toBe(403);
    });

    it('a virus refuses the upload and stores nothing', async () => {
        const count = await prisma.source.count({ where: { workspaceId: ctx.workspaceId } });
        const infected = async () => ({ status: 'INFECTED' as const, engine: 'test', durationMs: 1, threat: 'Eicar' });
        expect(await refusal(uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode('Wren and the river.'), filename: 'x.txt' }, { ...deps, scan: infected }))).toEqual({ status: 400, reason: 'UPLOAD_INFECTED' });
        expect(await prisma.source.count({ where: { workspaceId: ctx.workspaceId } })).toBe(count);
    });

    it('removing a source takes its chunks, facts and vectors with it', async () => {
        const vectorsBefore = await prisma.vectorEmbedding.count({ where: { sourceModel: 'SourceChunk', workspaceId: ctx.workspaceId } });
        expect(vectorsBefore).toBeGreaterThan(0);
        await removeSource(ctx, sourceId);
        expect(await prisma.sourceChunk.count({ where: { sourceId } })).toBe(0);
        expect(await prisma.storyFact.count({ where: { sourceId } })).toBe(0);
        expect(await prisma.vectorEmbedding.count({ where: { sourceModel: 'SourceChunk', workspaceId: ctx.workspaceId } })).toBe(0);
    });
});

describe('stopping cleanly, and resuming', () => {
    it('stops CEILING when the month would be passed, writes nothing for that chunk, and resumes from it', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Three Chapters' })).id;
        const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: longDraft(3), filename: 'long.txt' }, deps);
        expect(source.chunkCount).toBe(3);
        let calls = 0;
        const ceilingAfterOne: FactExtractor = {
            async extract(request, signal): Promise<ExtractResult> {
                calls++;
                if (calls === 2) return { ok: false, failure: 'WORKSPACE_CEILING', errorCode: 'CEILING', tokensUsed: 0, costMicroUsd: 0, callIds: [] };
                return stubExtractor(ctx).extract(request, signal);
            },
        };
        const first = await ingest(ctx, source.id, { extractor: () => ceilingAfterOne });
        expect(first.outcome).toBe('CEILING');
        const stopped = await getSource(ctx, source.id);
        expect(stopped).toMatchObject({ status: 'STOPPED', outcome: 'CEILING', chunksDone: 1 });
        // The resume confirms the remaining chunks' cost and reads only them.
        const r = await refusal(dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: 0 }, deps));
        expect(r.reason).toBe('ESTIMATE_CHANGED');
        const remaining = await (async () => {
            try {
                await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: 0 }, deps);
            } catch (err) {
                return (err as AppError & { details: { worstCaseMicroUsd: number } }).details.worstCaseMicroUsd;
            }
            return 0;
        })();
        expect(remaining).toBeLessThan(stopped.worstCaseMicroUsd);
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: remaining }, deps);
        const extracted: string[] = [];
        const watching: FactExtractor = {
            async extract(request, signal) {
                extracted.push(/Chapter \d/.exec(request.data.find((b) => b.label === 'passage.text')!.text)?.[0] ?? '');
                return stubExtractor(ctx).extract(request, signal);
            },
        };
        const second = await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { ...ingestDeps, extractor: () => watching });
        expect(second.outcome).toBe('OK');
        expect(extracted).toEqual(['Chapter 2', 'Chapter 3']);
        expect(await getSource(ctx, source.id)).toMatchObject({ status: 'DONE', chunksDone: 3 });
        expect((await listBookFacts(ctx, bookId, { status: 'ALL' })).facts.filter((f) => f.predicate === 'WANT')).toHaveLength(3);
    });

    it('stops BUDGET when the next chunk would pass the amount the author confirmed', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Budget' })).id;
        const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: longDraft(2), filename: 'b.txt' }, deps);
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, deps);
        // The budget written for the dispatch, lowered as a stale confirmation would leave it.
        await prisma.source.update({ where: { id: source.id }, data: { budgetMicroUsd: BigInt(1) } });
        const r = await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, ingestDeps);
        expect(r.outcome).toBe('BUDGET');
        expect(await getSource(ctx, source.id)).toMatchObject({ status: 'STOPPED', outcome: 'BUDGET', chunksDone: 0 });
    });
});

describe('an ingestion’s claim and its signs of life', () => {
    it('ingests a source uploaded long before its cost was confirmed (never stale by its upload time)', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Old Upload' })).id;
        const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: longDraft(1), filename: 'old.txt' }, deps);
        // Uploaded two hours ago; confirmed and dispatched now.
        await prisma.source.update({ where: { id: source.id }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
        expect(await getSource(ctx, source.id)).toMatchObject({ status: 'ESTIMATED' });
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, deps);
        expect(await getSource(ctx, source.id)).toMatchObject({ status: 'QUEUED', outcome: null });
        const r = await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, ingestDeps);
        expect(r.outcome).toBe('OK');
        expect(await getSource(ctx, source.id)).toMatchObject({ status: 'DONE', chunksDone: 1 });
    });

    it('a stale claim queued again belongs to its new worker: the old worker writes nothing more', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Two Workers' })).id;
        const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: longDraft(2), filename: 'two.txt' }, deps);
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, deps);

        // Worker 1 is held inside its first call.
        let releaseFirst!: () => void;
        let firstInCall!: () => void;
        const firstCalled = new Promise<void>((resolve) => (firstInCall = resolve));
        const heldFirst = new Promise<void>((resolve) => (releaseFirst = resolve));
        const slowFirst: FactExtractor = {
            async extract(request, signal) {
                firstInCall();
                await heldFirst;
                const r = await stubExtractor(ctx).extract(request, signal);
                return { ...r, costMicroUsd: 1_000 };
            },
        };
        const first = executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { ...ingestDeps, extractor: () => slowFirst });
        await firstCalled;

        // Its claim goes stale (no sign of life for an hour), the author resumes, and worker 2 claims it.
        await prisma.source.update({ where: { id: source.id }, data: { heartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } });
        expect(await getSource(ctx, source.id)).toMatchObject({ status: 'STOPPED', outcome: 'CLAIM_EXPIRED' });
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, deps);
        let releaseSecond!: () => void;
        let secondInCall!: () => void;
        const secondCalled = new Promise<void>((resolve) => (secondInCall = resolve));
        const heldSecond = new Promise<void>((resolve) => (releaseSecond = resolve));
        let secondCalls = 0;
        const slowSecond: FactExtractor = {
            async extract(request, signal) {
                secondCalls++;
                secondInCall();
                await heldSecond;
                const r = await stubExtractor(ctx).extract(request, signal);
                return { ...r, costMicroUsd: 7 };
            },
        };
        const second = executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { ...ingestDeps, extractor: () => slowSecond });
        await secondCalled;

        // Worker 1's call returns while worker 2 runs: nothing of it is written, and it stops.
        releaseFirst();
        expect(await first).toEqual({ ran: true, outcome: null });
        expect(await getSource(ctx, source.id)).toMatchObject({ status: 'RUNNING', chunksDone: 0, factCount: 0, spentMicroUsd: 0 });

        releaseSecond();
        expect((await second).outcome).toBe('OK');
        expect(secondCalls).toBe(2);
        const done = await getSource(ctx, source.id);
        expect(done).toMatchObject({ status: 'DONE', chunksDone: 2, spentMicroUsd: 14 });
        expect((await listBookFacts(ctx, bookId, { status: 'ALL' })).facts.filter((f) => f.predicate === 'WANT')).toHaveLength(2);
    });

    it('stops PARTIAL when the model-call minute stays full, and never makes a call it did not charge (D17)', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Full Minute' })).id;
        const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: longDraft(1), filename: 'full.txt' }, deps);
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, deps);
        let calls = 0;
        const counting: FactExtractor = {
            async extract(request, signal) {
                calls++;
                return stubExtractor(ctx).extract(request, signal);
            },
        };
        const full = () => {
            throw new RateLimitedError('full', { reason: 'MODEL_RATE_LIMITED', retryAfterMs: 60_000 });
        };
        const r = await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { ...ingestDeps, extractor: () => counting, charge: full, sleep: async () => undefined });
        expect(r.outcome).toBe('PARTIAL');
        expect(calls).toBe(0);
        expect(await getSource(ctx, source.id)).toMatchObject({ status: 'STOPPED', outcome: 'PARTIAL', chunksDone: 0 });
    });
});

describe('a changed re-upload', () => {
    it('is the next version, superseding the old, and carries decisions over for the same passage', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Versions' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren' });
        const v1 = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode('Wren wants a boat of her own one day.'), filename: 'notes.txt' }, deps);
        await ingest(ctx, v1.id);
        const fact = (await listBookFacts(ctx, bookId)).facts[0];
        await decideFact(ctx, fact.id, 'CONFIRM');
        const v2 = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode('Wren wants a boat of her own one day. Ostrik keeps the lighthouse lamp burning.'), filename: 'notes.txt' }, deps);
        expect(v2).toMatchObject({ version: 2, supersedesId: v1.id });
        await ingest(ctx, v2.id);
        const facts = (await listBookFacts(ctx, bookId, { status: 'ALL', sourceId: v2.id })).facts;
        expect(facts.find((f) => f.predicate === 'WANT')?.status).toBe('CONFIRMED');
        expect(facts.find((f) => f.subjectName === 'Ostrik')?.status).toBe('PENDING');
    });

    it('carries a decision only onto the same claim: another fact quoting the same passage starts pending', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Same Passage' })).id;
        const passage = 'Mara served as captain and surgeon of the ship.';
        const fact = (statement: string) => ({ subject: 'Mara', predicate: 'ROLE', object: '', statement, quote: passage, storyTimeFrom: '', storyTimeTo: '' });
        const answering = (statement: string): FactExtractor => ({
            async extract() {
                return { ok: true, output: { facts: [fact(statement)] }, tokensUsed: 10, costMicroUsd: 1, callIds: [] };
            },
        });
        const v1 = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode(passage), filename: 'mara.txt' }, deps);
        await ingest(ctx, v1.id, { extractor: () => answering('Mara served as captain.') });
        const captain = (await listBookFacts(ctx, bookId)).facts[0];
        expect(captain.statement).toBe('Mara served as captain.');
        await decideFact(ctx, captain.id, 'CONFIRM');
        const v2 = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode(`${passage} The ship sailed at dawn.`), filename: 'mara.txt' }, deps);
        // The same predicate, subject and quote — but a claim the author never confirmed.
        await ingest(ctx, v2.id, { extractor: () => answering('Mara served as surgeon.') });
        const surgeon = (await listBookFacts(ctx, bookId, { status: 'ALL', sourceId: v2.id })).facts[0];
        expect(surgeon).toMatchObject({ statement: 'Mara served as surgeon.', status: 'PENDING' });
    });
});

describe('the series library and its isolation', () => {
    let ctx: ReturnType<typeof workspaceCtx>;
    let bookA: string;
    let bookB: string;
    let wrenA: string;
    let wrenB: string;
    let seriesSourceId: string;
    let bookAOwnSourceId: string;

    beforeAll(async () => {
        const owner = await createAccount();
        ctx = workspaceCtx(owner);
        bookA = (await createBook(ctx, { title: 'Book Two' })).id;
        bookB = (await createBook(ctx, { title: 'Spin-off' })).id;
        wrenA = (await createElement(ctx, bookA, { kind: 'CHARACTER', name: 'Wren', fields: [{ key: 'role', value: 'A sailor' }] })).id;
        wrenB = (await createElement(ctx, bookB, { kind: 'CHARACTER', name: 'Wren', fields: [{ key: 'role', value: 'A sailor' }] })).id;
        const series = await uploadSource(ctx, { kind: 'series' }, { bytes: new TextEncoder().encode(`Book one. Wren wants to sail beyond the reef. Marker ${randomBytes(4).toString('hex')}.`), filename: 'book-one.txt' }, deps);
        seriesSourceId = series.id;
        await ingest(ctx, seriesSourceId);
        const own = await uploadSource(ctx, { kind: 'book', bookId: bookA }, { bytes: new TextEncoder().encode('Lantern notes. Ostrik keeps the harbour lamps lit every night.'), filename: 'a.txt' }, deps);
        bookAOwnSourceId = own.id;
        await ingest(ctx, own.id);
    });

    it('a series fact counts for a book only once it opts in, with its provenance', async () => {
        expect((await listBookFacts(ctx, bookA)).facts.every((f) => f.provenance.scope === 'BOOK')).toBe(true);
        await setSeriesOptIn(ctx, bookA, seriesSourceId, true);
        const page = await listBookFacts(ctx, bookA);
        const inherited = page.facts.find((f) => f.provenance.scope === 'SERIES');
        expect(inherited).toMatchObject({ provenance: { filename: 'book-one.txt', scope: 'SERIES' }, answers: { elementId: wrenA, fieldKey: 'want' } });
        await decideFact(ctx, inherited!.id, 'CONFIRM');
        const a = await startInterview(ctx, bookA, { scope: 'ELEMENT', elementId: wrenA, depth: 5, detail: 3 }, { generator: fakeGenerator(), embedder });
        expect((await frontierFor(ctx, bookA, a, wrenA)).answeredBy.want).toBe('source-facts');
        // Book B has not opted in: the series fact answers nothing there.
        const b = await startInterview(ctx, bookB, { scope: 'ELEMENT', elementId: wrenB, depth: 5, detail: 3 }, { generator: fakeGenerator(), embedder });
        expect((await frontierFor(ctx, bookB, b, wrenB)).asks).toContain('want');
        expect((await listBookFacts(ctx, bookB, { status: 'ALL' })).facts).toHaveLength(0);
        expect((await listSeriesFacts(ctx, { status: 'ALL' })).facts.length).toBeGreaterThan(0);
    });

    it('an override is the book’s own answer, for that book only; the series fact stays as it is', async () => {
        const inherited = (await listBookFacts(ctx, bookA, { status: 'CONFIRMED' })).facts.find((f) => f.provenance.scope === 'SERIES')!;
        await setFactOverride(ctx, bookA, inherited.id, { text: 'In this book Wren gives up the sea.' });
        const page = await listBookFacts(ctx, bookA, { status: 'CONFIRMED' });
        expect(page.facts.find((f) => f.id === inherited.id)?.override?.text).toBe('In this book Wren gives up the sea.');
        // The field stays answered — by the book's own answer.
        const a = await startInterview(ctx, bookA, { scope: 'ELEMENT', elementId: wrenA, depth: 5, detail: 3 }, { generator: fakeGenerator(), embedder });
        expect((await frontierFor(ctx, bookA, a, wrenA)).answeredBy.want).toBe('source-facts');
        // Another book that opts in reads the series fact itself, unchanged.
        await setSeriesOptIn(ctx, bookB, seriesSourceId, true);
        const b = (await listBookFacts(ctx, bookB, { status: 'CONFIRMED' })).facts.find((f) => f.id === inherited.id);
        expect(b).toMatchObject({ statement: inherited.statement, override: null });
        const context = await runInWorkspaceContext(ctx, (db) => assembleSourceContext(db, ctx, bookA, [{ elementId: wrenA, kind: 'CHARACTER', name: 'Wren' }]));
        expect(context.facts).toContainEqual({ subject: 'Wren', statement: 'In this book Wren gives up the sea.', from: 'OVERRIDE' });
        // Only an inherited fact may be overridden.
        const own = (await listBookFacts(ctx, bookA, { status: 'ALL', sourceId: bookAOwnSourceId })).facts[0];
        await decideFact(ctx, own.id, 'CONFIRM');
        expect(await refusal(setFactOverride(ctx, bookA, own.id, { text: 'x' }))).toEqual({ status: 409, reason: 'OVERRIDE_NOT_INHERITED' });
        await clearFactOverride(ctx, bookA, inherited.id);
        expect((await listBookFacts(ctx, bookA, { status: 'CONFIRMED' })).facts.find((f) => f.id === inherited.id)?.override).toBeNull();
        await setSeriesOptIn(ctx, bookB, seriesSourceId, false);
    });

    it('retrieval reads only the sources the book draws on, never another book’s or a series source it did not choose', async () => {
        const scope = [{ elementId: wrenB, kind: 'CHARACTER' as const, name: 'Wren' }];
        const query = (await new StubEmbeddingProvider().embed(['Wren'], { inputType: 'query' })) as unknown as { ok: true; vectors: number[][] };
        const revision = new StubEmbeddingProvider().revision;
        // Every chunk of the workspace is a vector candidate…
        const hits = await runInWorkspaceContext(ctx, (db) => getVectorRepository().search(db, ctx.workspaceId, { embeddingRevision: revision, embedding: query.vectors[0], k: 20, sourceModels: ['SourceChunk'] }));
        expect(hits.length).toBeGreaterThanOrEqual(2);
        // …but book B (opted out again) reads none of them: not book A's own source, not the series one.
        const b = await runInWorkspaceContext(ctx, (db) => assembleSourceContext(db, ctx, bookB, scope, { vector: query.vectors[0], revision }));
        expect(b).toEqual({ facts: [], passages: [], truncated: false });
        const a = await runInWorkspaceContext(ctx, (db) => assembleSourceContext(db, ctx, bookA, [{ elementId: wrenA, kind: 'CHARACTER', name: 'Wren' }], { vector: query.vectors[0], revision }));
        expect(a.passages.length).toBeGreaterThan(0);
        expect(a.passages.some((p) => p.text.includes('reef'))).toBe(true);
    });

    it('another workspace reaches none of it', async () => {
        const other = workspaceCtx(await createAccount());
        const fact = (await listSeriesFacts(ctx, { status: 'ALL' })).facts[0];
        expect((await refusal(decideFact(other, fact.id, 'REJECT'))).status).toBe(404);
        expect((await refusal(getSource(other, seriesSourceId))).status).toBe(404);
        expect((await refusal(listBookFacts(other, bookA))).status).toBe(404);
        expect((await listSeriesFacts(other)).facts).toHaveLength(0);
        expect((await refusal(setSeriesOptIn(other, bookA, seriesSourceId, true))).status).toBe(404);
    });
});
