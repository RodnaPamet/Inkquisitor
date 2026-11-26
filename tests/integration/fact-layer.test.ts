/**
 * THE FACT LAYER END TO END (Phase 4.1, D27), against a real PostgreSQL. The
 * model is the loopback stub (`stubMessagesFetch`) through 2.1's real path, or
 * a scripted extractor; nothing reaches a network.
 *
 *   the outbox: an accepted version writes its extraction row with it, a
 *   rolled-back one writes none, and the dispatcher queues only committed rows
 *   extraction: facts CONFIRMED and automatic, counting at once (the frontier
 *   skips the field); run twice, it writes nothing more
 *   a contradiction is PROPOSED, both facts stay live until the author decides
 *   deleting an element (or a relation) takes its facts with it
 *   the stops: the kill switch, the ceiling, the model-call minute, D11
 *   embeddings in the background; the vector query's allowed set; isolation
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, deleteElement, updateElement } from '@/app-layer/usecases/bible-elements';
import { addRelation, removeRelation } from '@/app-layer/usecases/bible-relations';
import { recordVersion } from '@/app-layer/usecases/bible-common';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { startInterview } from '@/app-layer/usecases/interviews';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { frontierOf, loadInterviewState, requireSession, type InterviewView } from '@/app-layer/usecases/interview-state';
import { executeBibleFactExtraction } from '@/app-layer/usecases/bible-facts';
import { executeFactLayerDispatch } from '@/app-layer/usecases/fact-layer-dispatch';
import { decideFactProposal, listFactProposals } from '@/app-layer/usecases/fact-proposals';
import { assembleSourceContext } from '@/app-layer/usecases/source-retrieval';
import { FactExtractionRepository } from '@/app-layer/repositories/fact-layer.repository';
import { getVectorRepository } from '@/app-layer/repositories/vector.repository';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { stubMessagesFetch } from '@/lib/ai/model-stub';
import { AppError, RateLimitedError } from '@/lib/errors/types';
import { defaultBibleFactExtractor } from '@/lib/facts/model-seam';
import type { ExtractResult, FactExtractor } from '@/lib/sources/extractor';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { ANY_DUE, seedFactLayer } from '../helpers/facts';
import { BIBLE_FACT_PIECE_MAX_CHARS, FACT_EXTRACTION_ATTEMPTS_MAX } from '@/lib/facts/vocabulary';
import { BIBLE_FACTS_CALL_COST_BUDGET_MICRO_USD } from '@/lib/facts/prompt';
import { periodStartOf } from '@/lib/ai/call-record';
import { embedderFrom, type QuestionEmbedder } from '@/app-layer/usecases/question-embeddings';
import { BibleFactRepository } from '@/app-layer/repositories/source.repository';
import { ingestText, seedSourceLibrary } from '../helpers/sources';
import { decideFact, listBookFacts } from '@/app-layer/usecases/source-facts';
import type { EmbeddingProvider } from '@/lib/ai/embeddings';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let undoKey: () => void;
beforeAll(() => {
    undoKey = setFakeApiKey();
});
afterAll(() => undoKey());

type Ctx = ReturnType<typeof workspaceCtx>;
const stubExtractor = (ctx: Parameters<typeof defaultBibleFactExtractor>[0]) => defaultBibleFactExtractor(ctx, { fetch: stubMessagesFetch as typeof fetch });
const unlimited = () => undefined;

function scripted(answer: (data: ReadonlyArray<{ label: string; text: string }>) => unknown, calls: { n: number } = { n: 0 }): () => FactExtractor {
    return () => ({
        async extract(request): Promise<ExtractResult> {
            calls.n++;
            return { ok: true, output: answer(request.data), tokensUsed: 10, costMicroUsd: 7, callIds: [] };
        },
    });
}

async function rows(ctx: Ctx, bookId: string) {
    return runInWorkspaceContext(ctx, (db) => FactExtractionRepository.listForBook(db, ctx.workspaceId, bookId, 100));
}

/** Queue and run every due extraction of the workspace (what the dispatcher and the worker do), the extractor given. */
async function extractAll(ctx: Ctx, extractor: () => FactExtractor = () => stubExtractor(ctx)) {
    const queued: string[] = [];
    await executeFactLayerDispatch({
        enqueue: async (_name, payload) => {
            queued.push((payload as { extractionId: string }).extractionId);
        },
        extractionOpen: () => true,
        embedder: () => null,
        workspaceIds: [ctx.workspaceId],
        now: () => new Date(Date.now() + 60_000),
    });
    const outcomes: Array<string | null> = [];
    for (const extractionId of queued) {
        const r = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId }, { extractor, charge: unlimited, gate: () => ({ mounted: true, recordKind: 'structural' }) });
        outcomes.push(r.outcome);
    }
    return outcomes;
}

async function bibleFacts(bookId: string) {
    return runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findMany({ where: { bookId }, orderBy: { createdAt: 'asc' }, select: { id: true, sourceKind: true, status: true, automatic: true, predicate: true, elementId: true, relationId: true, supersededAt: true, invalidatedByFactId: true } }));
}

async function frontierFor(ctx: Ctx, bookId: string, view: InterviewView, elementId: string) {
    return runInWorkspaceContext(ctx, async (db) => {
        const session = await requireSession(db, ctx, bookId, view.session.id);
        const f = frontierOf(await loadInterviewState(db, ctx, session), 5);
        return {
            asks: f.frontier.filter((e) => e.elementId === elementId).map((e) => e.fieldKey),
            answeredBy: Object.fromEntries(f.answered.filter((a) => a.elementId === elementId).map((a) => [a.fieldKey, a.by])),
        };
    });
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, reason: (err.details as { reason?: unknown } | undefined)?.reason };
        throw err;
    }
    throw new Error('expected a refusal');
}

describe('the outbox: after commit, and never for a rollback', () => {
    it('an accepted version writes its extraction row in its own transaction; a rolled-back one writes none, and the dispatcher queues only the first', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'The Outbox' })).id;
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren wants to cross the river before the spring floods.' });
        const committed = await rows(ctx, bookId);
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({ kind: 'BIBLE_VERSION', elementId: el.id, status: 'PENDING' });

        // A save that rolls back after its version was written: no row survives it.
        await expect(
            runInWorkspaceContext(ctx, async (db) => {
                await BibleElementRepository.lock(db, el.id);
                await recordVersion(db, ctx, bookId, el.id, { source: 'MANUAL' });
                throw new Error('rolled back');
            }),
        ).rejects.toThrow('rolled back');
        expect(await rows(ctx, bookId)).toHaveLength(1);

        const queued: Array<{ extractionId: string; jobId?: string }> = [];
        const tick = (now: Date) =>
            executeFactLayerDispatch({ enqueue: async (_n, p, o) => void queued.push({ extractionId: (p as { extractionId: string }).extractionId, jobId: o?.jobId }), extractionOpen: () => true, embedder: () => null, workspaceIds: [ctx.workspaceId], now: () => now });
        // A version settles first (a run of autosaves is extracted once): too fresh, nothing queued.
        await tick(new Date());
        expect(queued).toHaveLength(0);
        const r = await tick(new Date(Date.now() + 60_000));
        expect(r.queued).toBe(1);
        expect(queued).toEqual([{ extractionId: committed[0].id, jobId: `bible-facts-${committed[0].id}-1` }]);
        expect((await rows(ctx, bookId))[0]).toMatchObject({ status: 'QUEUED', attempts: 1 });
        // While the deployment cannot extract (no call, or no record it accepts), nothing is queued and the rows wait.
        const closed = await executeFactLayerDispatch({ enqueue: async () => undefined, extractionOpen: () => false, embedder: () => null, workspaceIds: [ctx.workspaceId] });
        expect(closed).toMatchObject({ extractionClosed: true, queued: 0 });
    });
});

describe('bible facts count at once, and extraction is idempotent', () => {
    it('extracts the accepted version’s facts CONFIRMED and automatic; the frontier skips the field they answer; run again, writes nothing', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'The Lock Keeper' })).id;
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', fields: [{ key: 'role', value: 'The lock keeper’s daughter' }] });
        const before = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: wren.id, depth: 5, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        expect((await frontierFor(ctx, bookId, before, wren.id)).asks).toContain('want');

        await updateElement(ctx, bookId, wren.id, { summary: 'Wren wants to cross the river before the spring floods.', baseVersion: 1 });
        const outcomes = await extractAll(ctx);
        // The first version is superseded by the second: one call, for the newest.
        expect(outcomes.sort()).toEqual(['OK', 'SUPERSEDED']);
        const facts = await bibleFacts(bookId);
        expect(facts.length).toBeGreaterThan(0);
        expect(facts.every((f) => f.sourceKind === 'BIBLE_VERSION' && f.status === 'CONFIRMED' && f.automatic && f.elementId === wren.id)).toBe(true);
        expect(facts.some((f) => f.predicate === 'WANT')).toBe(true);

        const after = await frontierFor(ctx, bookId, before, wren.id);
        expect(after.asks).not.toContain('want');
        expect(after.answeredBy.want).toBe('bible-facts');
        // The AiCallLog row of the call names its book; nothing of the text.
        const calls = await runWithoutRls({ reason: 'test' }, (db) => db.aiCallLog.findMany({ where: { workspaceId: ctx.workspaceId, purpose: 'facts.bible-extract' } }));
        expect(calls.length).toBe(1);
        expect(calls[0].bookId).toBe(bookId);

        // Idempotent: the same version run again (re-queued by hand) writes no fact, provenance or proposal.
        const done = (await rows(ctx, bookId)).find((r) => r.outcome === 'OK')!;
        await runWithoutRls({ reason: 'test' }, (db) => db.bibleFactExtraction.update({ where: { id: done.id }, data: { status: 'QUEUED' } }));
        const again = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: done.id }, { extractor: () => stubExtractor(ctx), charge: unlimited, gate: () => ({ mounted: true, recordKind: 'structural' }) });
        expect(again.outcome).toBe('OK');
        expect(await bibleFacts(bookId)).toHaveLength(facts.length);
        const counts = await runWithoutRls({ reason: 'test' }, async (db) => ({
            provenance: await db.storyFactProvenance.count({ where: { workspaceId: ctx.workspaceId } }),
            proposals: await db.storyFactProposal.count({ where: { workspaceId: ctx.workspaceId } }),
        }));
        expect(counts.provenance).toBe(facts.length);
        expect(counts.proposals).toBe(0);
        // And a DONE row is never claimed again.
        expect((await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: done.id }, { extractor: () => stubExtractor(ctx) })).ran).toBe(false);
    });

    it('a version that changes nothing fact-bearing is extracted with no call (NO_CHANGE)', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Still Water' })).id;
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ilse', summary: 'Ilse keeps bees on the roof of the old observatory.' });
        const calls = { n: 0 };
        await extractAll(ctx, scripted(() => ({ facts: [] }), calls));
        await updateElement(ctx, bookId, el.id, { status: 'SETTLED', baseVersion: 1 });
        expect(await extractAll(ctx, scripted(() => ({ facts: [] }), calls))).toEqual(['NO_CHANGE']);
        expect(calls.n).toBe(1);
    });
});

const age = (n: number) =>
    scripted((data) => {
        const text = data.find((b) => b.label === 'entry.text')!.text;
        const shown = data.find((b) => b.label === 'existing-facts')?.text ?? '';
        const contradicts = shown.split('\n').filter((l) => /\[AGE\]/.test(l)).map((l) => Number(/^(\d+)\./.exec(l)![1]));
        return text.includes(`${n} years old`)
            ? { facts: [{ subject: 'Wren', predicate: 'AGE', object: `${n} years old`, statement: `Wren is ${n} years old.`, quote: `Wren is ${n} years old`, storyTimeFrom: '', storyTimeTo: '', contradicts }] }
            : { facts: [] };
    });

describe('a contradiction is proposed, never applied', () => {
    let ctx: Ctx;
    let bookId: string;
    let wrenId: string;
    beforeEach(async () => {
        const owner = await createAccount();
        ctx = workspaceCtx(owner);
        bookId = (await createBook(ctx, { title: 'Two Ages' })).id;
        wrenId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren is 12 years old.' })).id;
        await extractAll(ctx, age(12));
        await updateElement(ctx, bookId, wrenId, { summary: 'Wren is 13 years old.', baseVersion: 1 });
        await extractAll(ctx, age(13));
    });

    it('both facts stay live and the older is proposed for invalidation; INVALIDATE supersedes it, once', async () => {
        const facts = (await bibleFacts(bookId)).filter((f) => f.predicate === 'AGE');
        expect(facts).toHaveLength(2);
        expect(facts.every((f) => f.supersededAt === null)).toBe(true);
        const page = await listFactProposals(ctx, bookId);
        expect(page.pending).toBe(1);
        const p = page.proposals[0];
        expect(p).toMatchObject({ reason: 'CONTRADICTED', older: { statement: 'Wren is 12 years old.', live: true, origin: { kind: 'ELEMENT', elementName: 'Wren', versionNumber: 1 } }, newer: { statement: 'Wren is 13 years old.' } });
        expect(['RULE', 'MODEL']).toContain(p.basis);

        // A reader reads and may not decide.
        const reader = await createBareUser();
        await addMember(ctx.workspaceId, reader.id, 'READER');
        const readerCtx = workspaceCtx({ userId: reader.id, workspaceId: ctx.workspaceId, workspaceSlug: ctx.workspaceSlug }, 'READER');
        expect((await listFactProposals(readerCtx, bookId)).pending).toBe(1);
        expect((await refusal(decideFactProposal(readerCtx, bookId, p.id, { decision: 'INVALIDATE' }))).status).toBe(403);

        await decideFactProposal(ctx, bookId, p.id, { decision: 'INVALIDATE' });
        const after = (await bibleFacts(bookId)).filter((f) => f.predicate === 'AGE');
        const older = after.find((f) => f.id === p.older.id)!;
        expect(older.supersededAt).not.toBeNull();
        expect(older.invalidatedByFactId).toBe(p.newer!.id);
        expect(after.find((f) => f.id === p.newer!.id)!.supersededAt).toBeNull();
        expect((await refusal(decideFactProposal(ctx, bookId, p.id, { decision: 'KEEP_BOTH' }))).reason).toBe('PROPOSAL_DECIDED');
        expect((await listFactProposals(ctx, bookId)).pending).toBe(0);
        // The database holds the rest: an invalidation is never undone.
        await expect(runWithoutRls({ reason: 'test' }, (db) => db.storyFact.update({ where: { id: older.id }, data: { supersededAt: null } }))).rejects.toThrow(/STORY_FACT_FIXED/);
    });

    it('KEEP_BOTH leaves both live, and the pair is never proposed again', async () => {
        const p = (await listFactProposals(ctx, bookId)).proposals[0];
        // Phase 4.2 (D28): "both are true" of a contradiction carries the author's explanation.
        await decideFactProposal(ctx, bookId, p.id, { decision: 'KEEP_BOTH', explanation: 'Wren turned thirteen during the story.' });
        expect((await bibleFacts(bookId)).every((f) => f.supersededAt === null)).toBe(true);
        // The same version extracted again raises nothing new.
        const done = (await rows(ctx, bookId)).find((r) => r.outcome === 'OK' && r.status === 'DONE' && r.proposalsRaised === 1)!;
        await runWithoutRls({ reason: 'test' }, (db) => db.bibleFactExtraction.update({ where: { id: done.id }, data: { status: 'QUEUED' } }));
        await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: done.id }, { extractor: age(13), charge: unlimited, gate: () => ({ mounted: true, recordKind: 'structural' }) });
        expect((await listFactProposals(ctx, bookId)).pending).toBe(0);
    });
});

describe('a fact goes with what states it', () => {
    it('deleting an element removes its facts (and the proposals naming them); removing a relation removes the relation’s', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Cascade' })).id;
        const osei = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Commander Osei', summary: 'Commander Osei runs the station with a steady hand.' });
        const station = await createElement(ctx, bookId, { kind: 'SETTING', name: 'Station Kestrel', summary: 'Station Kestrel orbits the gas giant Varo.' });
        const relation = await addRelation(ctx, bookId, { fromElementId: osei.id, toElementId: station.id, type: 'related_to', note: 'Commander Osei has run Station Kestrel for six years.' });
        await extractAll(ctx);
        const facts = await bibleFacts(bookId);
        expect(facts.some((f) => f.relationId === relation.id)).toBe(true);
        expect(facts.some((f) => f.elementId === station.id)).toBe(true);

        await removeRelation(ctx, bookId, relation.id);
        expect((await bibleFacts(bookId)).some((f) => f.relationId === relation.id)).toBe(false);
        await deleteElement(ctx, bookId, station.id);
        const left = await bibleFacts(bookId);
        expect(left.some((f) => f.elementId === station.id)).toBe(false);
        expect(left.some((f) => f.elementId === osei.id)).toBe(true);
        // The deleted element's versions stay with the book (history), its facts do not; its extractions skip.
        await updateElement(ctx, bookId, osei.id, { summary: 'Commander Osei runs the station.', baseVersion: 1 });
        expect(await extractAll(ctx)).toContain('OK');
    });
});

describe('the stops', () => {
    async function oneQueued(): Promise<{ ctx: Ctx; bookId: string; id: string }> {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Stops' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren wants to cross the river before the spring floods.' });
        const [row] = await rows(ctx, bookId);
        await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.markQueued(db, ctx.workspaceId, row.id, new Date(), ANY_DUE));
        return { ctx, bookId, id: row.id };
    }
    const gate = () => ({ mounted: true as const, recordKind: 'structural' as const });

    it('the kill switch stops it before any call, resumable later', async () => {
        const { ctx, bookId, id } = await oneQueued();
        const calls = { n: 0 };
        const before = process.env.AI_DISABLED;
        process.env.AI_DISABLED = '1';
        try {
            const r = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: id }, { extractor: scripted(() => ({ facts: [] }), calls), charge: unlimited, gate });
            expect(r.outcome).toBe('KILL_SWITCH');
        } finally {
            if (before === undefined) delete process.env.AI_DISABLED;
            else process.env.AI_DISABLED = before;
        }
        expect(calls.n).toBe(0);
        const row = (await rows(ctx, bookId))[0];
        expect(row).toMatchObject({ status: 'STOPPED', outcome: 'KILL_SWITCH' });
        expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('the ceiling stops it cleanly with what the call cost counted, and no fact', async () => {
        const { ctx, bookId, id } = await oneQueued();
        const ceiling = (): FactExtractor => ({ extract: async () => ({ ok: false, failure: 'WORKSPACE_CEILING', errorCode: 'CEILING', tokensUsed: 0, costMicroUsd: 3, callIds: [] }) });
        const r = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: id }, { extractor: ceiling, charge: unlimited, gate });
        expect(r.outcome).toBe('CEILING');
        expect((await rows(ctx, bookId))[0]).toMatchObject({ status: 'STOPPED', outcome: 'CEILING', costMicroUsd: BigInt(3) });
        expect(await bibleFacts(bookId)).toHaveLength(0);
    });

    it('a full model-call minute stops it with no call made (D17); no evaluation record stops it NOT_EVALUATED (D11)', async () => {
        const { ctx, bookId, id } = await oneQueued();
        const calls = { n: 0 };
        const full = () => {
            throw new RateLimitedError('full', { retryAfterMs: 60_000 });
        };
        const r = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: id }, { extractor: scripted(() => ({ facts: [] }), calls), charge: full, sleep: async () => undefined, gate });
        expect(r.outcome).toBe('MODEL_RATE_LIMITED');
        expect(calls.n).toBe(0);

        await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.markQueued(db, ctx.workspaceId, id, new Date(), ANY_DUE));
        const refused = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: id }, { extractor: scripted(() => ({ facts: [] }), calls), charge: unlimited, gate: () => ({ mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: '' }) });
        expect(refused.outcome).toBe('NOT_EVALUATED');
        expect(calls.n).toBe(0);
        expect((await rows(ctx, bookId))[0].status).toBe('STOPPED');
    });

    it('an author who may no longer edit the bible is never spent for', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const editor = await createBareUser();
        await addMember(ctx.workspaceId, editor.id, 'EDITOR');
        const editorCtx = workspaceCtx({ userId: editor.id, workspaceId: ctx.workspaceId, workspaceSlug: ctx.workspaceSlug }, 'EDITOR');
        const bookId = (await createBook(ctx, { title: 'Gone' })).id;
        await createElement(editorCtx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren wants to cross the river before the spring floods.' });
        await runWithoutRls({ reason: 'test' }, (db) => db.workspaceMembership.updateMany({ where: { workspaceId: ctx.workspaceId, userId: editor.id }, data: { role: 'READER' } }));
        const calls = { n: 0 };
        expect(await extractAll(ctx, scripted(() => ({ facts: [] }), calls))).toEqual(['AUTHOR_NOT_PERMITTED']);
        expect(calls.n).toBe(0);
    });
});

describe('embeddings, in the background', () => {
    it('an element, its facts and an answer are embedded by the dispatcher (never on the request path), and go with their rows', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Vectors' })).id;
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren wants to cross the river before the spring floods.' });
        await extractAll(ctx);
        // An answer given in an interview (ANSWERED) is marked for embedding too.
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el.id, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        const open = view.round!.questions.find((q) => q.kind === 'OPEN') ?? view.round!.questions[0];
        const answered = await answerQuestion(ctx, bookId, view.session.id, open.id, { text: 'She fears the water more than the flood.' });
        const tasks = () => runWithoutRls({ reason: 'test' }, (db) => db.embeddingTask.findMany({ where: { workspaceId: ctx.workspaceId }, select: { sourceModel: true } }));
        expect((await tasks()).map((t) => t.sourceModel).sort()).toEqual(expect.arrayContaining(['Answer', 'BibleElement', 'StoryFact']));
        const r = await executeFactLayerDispatch({ extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });
        expect(r.embedded).toBeGreaterThanOrEqual(2);
        expect(await tasks()).toHaveLength(0);
        const revision = new StubEmbeddingProvider().revision;
        const keys = await runInWorkspaceContext(ctx, (db) => getVectorRepository().listKeys(db, ctx.workspaceId, revision));
        expect(keys.some((k) => k.sourceModel === 'BibleElement' && k.sourceId === el.id && k.bookId === bookId)).toBe(true);
        expect(keys.some((k) => k.sourceModel === 'StoryFact')).toBe(true);
        expect(answered.id).toBeTruthy();
        expect(keys.some((k) => k.sourceModel === 'Answer' && k.bookId === bookId)).toBe(true);
        await deleteElement(ctx, bookId, el.id);
        const after = await runInWorkspaceContext(ctx, (db) => getVectorRepository().listKeys(db, ctx.workspaceId, revision));
        expect(after.filter((k) => k.sourceModel === 'BibleElement' || k.sourceModel === 'StoryFact')).toHaveLength(0);
    });
});

describe('retrieval isolation: the allowed set is inside the vector query', () => {
    it('a book’s facts search ranks only its own facts, however many nearer ones another book holds; another workspace sees none', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const mine = (await createBook(ctx, { title: 'Mine' })).id;
        const theirs = (await createBook(ctx, { title: 'Theirs' })).id;
        const wren = await createElement(ctx, mine, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren keeps the lock at Harrow Weir.' });
        // Another book holds many facts with exactly the query's words: a top-k-then-filter search would return only theirs.
        for (let i = 0; i < 8; i++) await createElement(ctx, theirs, { kind: 'CHARACTER', name: `Wren ${i}`, summary: `Wren ${i} wants to cross the river before the spring floods.` });
        await extractAll(ctx);
        await executeFactLayerDispatch({ extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });
        await executeFactLayerDispatch({ extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });
        const provider = new StubEmbeddingProvider();
        const q = await provider.embed(['Wren wants to cross the river before the spring floods.'], { inputType: 'query' });
        if (!q.ok) throw new Error('stub');
        const query = { vector: q.vectors[0], revision: provider.revision };
        const unfiltered = await runInWorkspaceContext(ctx, (db) => getVectorRepository().search(db, ctx.workspaceId, { embeddingRevision: query.revision, embedding: query.vector, k: 5, sourceModels: ['StoryFact'] }));
        expect(unfiltered).toHaveLength(5);
        // With the allowed set IN the query, the top k is my book's own, however many of theirs rank above it.
        const mineOnly = await runInWorkspaceContext(ctx, (db) => getVectorRepository().search(db, ctx.workspaceId, { embeddingRevision: query.revision, embedding: query.vector, k: 5, within: { scope: 'facts-of-book', bookId: mine, sourceIds: [] } }));
        expect(mineOnly.length).toBeGreaterThan(0);
        const mineIds = new Set((await bibleFacts(mine)).map((f) => f.id));
        expect(mineOnly.every((h) => mineIds.has(h.sourceId))).toBe(true);
        // And a top-k-then-filter search would have found none of mine in its first five.
        expect(unfiltered.filter((h) => mineIds.has(h.sourceId)).length).toBeLessThan(mineOnly.length);
        // Another element of my book, outside the scope, whose fact the vector finds.
        const cal = await createElement(ctx, mine, { kind: 'CHARACTER', name: 'Cal', summary: 'Cal ferries goods across the river by night.' });
        await extractAll(ctx);
        await executeFactLayerDispatch({ extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });
        const context = await runInWorkspaceContext(ctx, (db) => assembleSourceContext(db, ctx, mine, [{ elementId: wren.id, kind: 'CHARACTER', name: 'Wren' }], query));
        expect(context.facts.length).toBeGreaterThanOrEqual(2);
        expect(context.facts.every((f) => !/Wren \d/.test(f.statement))).toBe(true);
        expect(context.facts.some((f) => f.statement.startsWith('Wren keeps the lock'))).toBe(true);
        expect(context.facts.some((f) => f.statement.startsWith('Cal'))).toBe(true);
        expect(cal.id).toBeTruthy();

        // Another workspace: the store is confined to it by RLS and by its own filter.
        const stranger = workspaceCtx(await createAccount());
        const hits = await runInWorkspaceContext(stranger, (db) => getVectorRepository().search(db, stranger.workspaceId, { embeddingRevision: query.revision, embedding: query.vector, k: 50, within: { scope: 'facts-of-book', bookId: mine, sourceIds: [] } }));
        expect(hits).toHaveLength(0);
        const foreign = await runInWorkspaceContext(stranger, (db) => db.storyFact.count({ where: { bookId: mine } }));
        expect(foreign).toBe(0);
    }, 60_000);
});

describe('isolation of the review', () => {
    it('another workspace cannot read or decide a book’s proposals', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Private' })).id;
        const stranger = workspaceCtx(await createAccount());
        expect((await refusal(listFactProposals(stranger, bookId))).status).toBe(404);
        expect((await refusal(decideFactProposal(stranger, bookId, randomUUID(), { decision: 'REJECT' }))).status).toBe(404);
    });
});

describe('review of 4.1: races and what the context shows', () => {
    const gate = () => ({ mounted: true as const, recordKind: 'structural' as const });

    it('a version superseded while its call ran is skipped at persist: no stale fact, and the newer fact is never proposed for invalidation by it', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Three Ages' })).id;
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren is 12 years old.' });
        await extractAll(ctx, age(12));
        await updateElement(ctx, bookId, wren.id, { summary: 'Wren is 13 years old.', baseVersion: 1 });
        const v2 = (await rows(ctx, bookId)).find((r) => r.status === 'PENDING')!;
        await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.markQueued(db, ctx.workspaceId, v2.id, new Date(), ANY_DUE));
        // While v2's call runs, the author saves v3, and v3 is extracted to the end (another worker).
        const inner = age(13)();
        const racing = (): FactExtractor => ({
            async extract(request, signal) {
                await updateElement(ctx, bookId, wren.id, { summary: 'Wren is 14 years old.', baseVersion: 2 });
                expect(await extractAll(ctx, age(14))).toEqual(['OK']);
                return inner.extract(request, signal);
            },
        });
        const r = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: v2.id }, { extractor: racing, charge: unlimited, gate });
        expect(r.outcome).toBe('SUPERSEDED');
        expect((await rows(ctx, bookId)).find((x) => x.id === v2.id)).toMatchObject({ status: 'SKIPPED', outcome: 'SUPERSEDED', factsAdded: 0, costMicroUsd: BigInt(7) });
        expect((await bibleFacts(bookId)).filter((f) => f.predicate === 'AGE')).toHaveLength(2);
        const page = await listFactProposals(ctx, bookId);
        expect(page.proposals.map((p) => [p.older.statement, p.newer?.statement ?? null])).toEqual([['Wren is 12 years old.', 'Wren is 14 years old.']]);
    });

    it('two dispatcher ticks never re-queue a row the other already queued and a worker claimed', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Two Ticks' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren wants to cross the river before the spring floods.' });
        const later = new Date(Date.now() + 60_000);
        const window = { now: later, settledBefore: new Date(later.getTime() - 20_000), staleBefore: new Date(later.getTime() - 30 * 60_000) };
        // Tick B discovered the row PENDING; tick A queued it and a worker claimed it before B marked it.
        const [row] = await rows(ctx, bookId);
        expect(await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.markQueued(db, ctx.workspaceId, row.id, later, window))).toBe(true);
        expect(await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.claim(db, ctx.workspaceId, row.id, later))).toBe(true);
        // Tick B's mark: the row is no longer due, so the live claim stands.
        expect(await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.markQueued(db, ctx.workspaceId, row.id, later, window))).toBe(false);
        expect((await rows(ctx, bookId))[0]).toMatchObject({ status: 'RUNNING', attempts: 1, startedAt: later });
    });

    it('an element saved while its embedding is being made is embedded again, as it now stands', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Moving Text' })).id;
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren wants to cross the river before the spring floods.' });
        const stub = new StubEmbeddingProvider();
        let saved = false;
        const racing: EmbeddingProvider = {
            providerId: stub.providerId,
            model: stub.model,
            dimensions: stub.dimensions,
            revision: stub.revision,
            async embed(texts, opts) {
                if (!saved) {
                    saved = true;
                    await updateElement(ctx, bookId, el.id, { summary: 'Wren fears the water more than the flood.', baseVersion: 1 });
                }
                return stub.embed(texts, opts);
            },
        };
        const elementKey = async () => (await runInWorkspaceContext(ctx, (db) => getVectorRepository().listKeys(db, ctx.workspaceId, stub.revision))).find((k) => k.sourceModel === 'BibleElement' && k.sourceId === el.id);
        await executeFactLayerDispatch({ extractionOpen: () => false, embedder: () => racing, workspaceIds: [ctx.workspaceId] });
        const first = await elementKey();
        expect(first).toBeDefined();
        // The save during the embedding left its task waiting.
        const waiting = await runWithoutRls({ reason: 'test' }, (db) => db.embeddingTask.count({ where: { workspaceId: ctx.workspaceId, sourceModel: 'BibleElement', sourceId: el.id } }));
        expect(waiting).toBe(1);
        await executeFactLayerDispatch({ extractionOpen: () => false, embedder: () => stub, workspaceIds: [ctx.workspaceId] });
        const second = await elementKey();
        expect(second!.contentHash).not.toBe(first!.contentHash);
        expect(await runWithoutRls({ reason: 'test' }, (db) => db.embeddingTask.count({ where: { workspaceId: ctx.workspaceId, sourceModel: 'BibleElement' } }))).toBe(0);
    });

    it('a source fact the author invalidated carries no decision into its source’s next version', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Salt Road' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara', summary: 'Mara wants the salt road closed for good.' });
        const sentence = 'Mara wants the salt road reopened before winter.';
        await ingestText(ctx, { kind: 'book', bookId }, sentence, 'draft.txt');
        const sourced = (await listBookFacts(ctx, bookId)).facts.find((f) => f.statement === sentence)!;
        await decideFact(ctx, sourced.id, 'CONFIRM');
        // The bible says otherwise: the model names the confirmed source fact it was shown.
        const contra = scripted((data) => {
            const shown = data.find((b) => b.label === 'existing-facts')?.text ?? '';
            const n = shown.split('\n').filter((l) => l.includes('reopened')).map((l) => Number(/^(\d+)\./.exec(l)![1]));
            return { facts: [{ subject: 'Mara', predicate: 'WANT', object: '', statement: 'Mara wants the salt road closed for good.', quote: 'Mara wants the salt road closed for good', storyTimeFrom: '', storyTimeTo: '', contradicts: n }] };
        });
        expect(await extractAll(ctx, contra)).toEqual(['OK']);
        const p = (await listFactProposals(ctx, bookId)).proposals.find((x) => x.older.id === sourced.id)!;
        expect(p).toMatchObject({ basis: 'MODEL', older: { origin: { kind: 'SOURCE' } } });
        await decideFactProposal(ctx, bookId, p.id, { decision: 'INVALIDATE' });
        // A changed file under the same name: the next version of the source states the same claim.
        await ingestText(ctx, { kind: 'book', bookId }, `${sentence} Mara keeps a ledger of every toll she has ever paid.`, 'draft.txt');
        const again = await runInWorkspaceContext(ctx, (db) =>
            db.storyFact.findMany({ where: { workspaceId: ctx.workspaceId, sourceKind: 'SOURCE_CHUNK', supersededAt: null, NOT: { id: sourced.id } }, select: { statement: true, status: true, carriedFromFactId: true } }),
        );
        const restated = again.find((f) => f.statement === sentence)!;
        expect(restated).toMatchObject({ status: 'PENDING', carriedFromFactId: null });
    });

    it('a series fact the book overrode reaches the context through the vector search as the book’s own answer, never the series’ words', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Overridden' })).id;
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren keeps the lock at Harrow Weir.' });
        const { seriesSourceId } = await seedSourceLibrary(ctx, bookId, 'Qv');
        const inherited = await runInWorkspaceContext(ctx, (db) => db.storyFact.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId, sourceId: seriesSourceId, status: 'CONFIRMED' }, select: { id: true, subjectName: true, statement: true } }));
        expect(await runWithoutRls({ reason: 'test' }, (db) => db.storyFactOverride.count({ where: { bookId, factId: inherited.id } }))).toBe(1);
        await executeFactLayerDispatch({ extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });
        await executeFactLayerDispatch({ extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });
        const provider = new StubEmbeddingProvider();
        const q = await provider.embed([inherited.statement], { inputType: 'query' });
        if (!q.ok) throw new Error('stub');
        const context = await runInWorkspaceContext(ctx, (db) => assembleSourceContext(db, ctx, bookId, [{ elementId: wren.id, kind: 'CHARACTER', name: 'Wren' }], { vector: q.vectors[0], revision: provider.revision }));
        expect(context.facts.some((f) => f.statement === inherited.statement)).toBe(false);
        expect(context.facts).toContainEqual({ subject: inherited.subjectName, statement: 'In this book Mara Qv stays.', from: 'OVERRIDE' });
    });
});

describe('owner decisions of 2026-11-21: at the ceiling, wait for next month', () => {
    const gate = () => ({ mounted: true as const, recordKind: 'structural' as const });
    const ceiling = (): FactExtractor => ({ extract: async () => ({ ok: false, failure: 'WORKSPACE_CEILING', errorCode: 'CEILING', tokensUsed: 0, costMicroUsd: 0, callIds: [] }) });

    async function spendTheMonth(workspaceId: string, ats: Date[]) {
        await runWithoutRls({ reason: 'test' }, async (db) => {
            for (const at of ats) {
                const periodStart = periodStartOf(at);
                await db.aiSpendMonth.upsert({ where: { workspaceId_periodStart: { workspaceId, periodStart } }, create: { workspaceId, periodStart, spentMicroUsd: BigInt(1_000_000_000_000) }, update: { spentMicroUsd: BigInt(1_000_000_000_000) } });
            }
        });
    }

    it('a stop at the ceiling counts no attempt: a month of hourly retries never ends a save ATTEMPTS_SPENT', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Waiting' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren wants to cross the river before the spring floods.' });
        const [row] = await rows(ctx, bookId);
        for (let i = 0; i <= FACT_EXTRACTION_ATTEMPTS_MAX + 1; i++) {
            await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.markQueued(db, ctx.workspaceId, row.id, new Date(), ANY_DUE));
            const r = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: row.id }, { extractor: ceiling, charge: unlimited, gate });
            expect(r.outcome).toBe('CEILING');
        }
        expect((await rows(ctx, bookId))[0]).toMatchObject({ status: 'STOPPED', outcome: 'CEILING', attempts: 0 });
    });

    it('the dispatcher queues nothing of a workspace whose month is spent, and catches up oldest first once it has room', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Spent' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren wants to cross the river before the spring floods.' });
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Cal', summary: 'Cal ferries goods across the river by night.' });
        const oldestFirst = (await rows(ctx, bookId)).map((r) => r.id).reverse();
        const first = new Date(Date.now() + 60_000);
        const later = new Date(first.getTime() + 2 * 60 * 60_000);
        await spendTheMonth(ctx.workspaceId, [first, later]);
        const tick = async (now: Date) => {
            const queued: string[] = [];
            const r = await executeFactLayerDispatch({ enqueue: async (_n, p) => void queued.push((p as { extractionId: string }).extractionId), extractionOpen: () => true, embedder: () => null, workspaceIds: [ctx.workspaceId], now: () => now });
            return { queued, r };
        };
        const spent = await tick(first);
        expect(spent.queued).toEqual([]);
        expect(spent.r.deferredAtCeiling).toBe(2);
        expect((await rows(ctx, bookId)).every((r) => r.status === 'STOPPED' && r.outcome === 'CEILING' && r.attempts === 0 && r.nextAttemptAt!.getTime() > first.getTime())).toBe(true);
        // Due again, the month still spent: still nothing queued.
        expect((await tick(later)).queued).toEqual([]);
        // The month has room (next month, or a raised ceiling): queued, oldest first.
        await runWithoutRls({ reason: 'test' }, (db) => db.aiSpendMonth.deleteMany({ where: { workspaceId: ctx.workspaceId } }));
        const resumed = await tick(new Date(later.getTime() + 2 * 60 * 60_000));
        expect(resumed.queued).toEqual(oldestFirst);
    });

    it('discovery shares the tick fairly: one workspace’s backlog never starves another’s new extraction', async () => {
        const busy = workspaceCtx(await createAccount());
        const quiet = workspaceCtx(await createAccount());
        const busyBook = (await createBook(busy, { title: 'Backlog' })).id;
        for (let i = 0; i < 4; i++) await createElement(busy, busyBook, { kind: 'CHARACTER', name: `Wren ${i}`, summary: `Wren ${i} wants to cross the river.` });
        const quietBook = (await createBook(quiet, { title: 'New' })).id;
        await createElement(quiet, quietBook, { kind: 'CHARACTER', name: 'Ilse', summary: 'Ilse keeps bees on the observatory roof.' });
        const due = await runWithoutRls({ reason: 'test' }, (db) => FactExtractionRepository.listDue(db, { ...ANY_DUE, take: 3, workspaceIds: [busy.workspaceId, quiet.workspaceId] }));
        expect(due.filter((d) => d.workspaceId === quiet.workspaceId)).toHaveLength(1);
        expect(due.filter((d) => d.workspaceId === busy.workspaceId)).toHaveLength(2);
        // And within a workspace, oldest first.
        const busyOldest = (await rows(busy, busyBook)).map((r) => r.id).reverse();
        expect(due.filter((d) => d.workspaceId === busy.workspaceId).map((d) => d.id)).toEqual(busyOldest.slice(0, 2));
    });
});

describe('owner decisions of 2026-11-21: each call’s input is capped, and its worst case fits the budget', () => {
    const gate = () => ({ mounted: true as const, recordKind: 'structural' as const });
    const paragraph = (i: number) => `Wren remembers the winter of the flood, part ${i}. ${'The river rose over the weir and the lock gates groaned. '.repeat(14)}`.trim();

    it('a long changed field is sent in bounded pieces at paragraph boundaries; a fact stated in two pieces is stored once', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Long Wound' })).id;
        // Fifty paragraphs (about 45,000 characters); the first and the last both say Wren keeps the lock.
        const html = Array.from({ length: 50 }, (_, i) => `<p>${i === 0 || i === 49 ? 'Wren keeps the lock at Harrow Weir. ' : ''}${paragraph(i)}</p>`).join('');
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', fields: [{ key: 'wound', value: html }] });
        const sent: string[] = [];
        const extractor = scripted((data) => {
            const text = data.find((b) => b.label === 'entry.text')!.text;
            sent.push(text);
            const facts: unknown[] = [];
            if (text.includes('Wren keeps the lock at Harrow Weir.')) facts.push({ subject: 'Wren', predicate: 'OTHER', object: '', statement: 'Wren keeps the lock at Harrow Weir.', quote: 'Wren keeps the lock at Harrow Weir.', storyTimeFrom: '', storyTimeTo: '', contradicts: [] });
            const part = /part (\d+)\./.exec(text);
            if (part) facts.push({ subject: 'Wren', predicate: 'BACKSTORY', object: '', statement: `Wren remembers the winter of the flood, part ${part[1]}.`, quote: `Wren remembers the winter of the flood, part ${part[1]}.`, storyTimeFrom: '', storyTimeTo: '', contradicts: [] });
            return { facts };
        });
        expect(await extractAll(ctx, extractor)).toEqual(['OK']);
        expect(sent.length).toBeGreaterThanOrEqual(3);
        for (const t of sent) {
            const body = t.split('\n').slice(2).join('\n');
            expect(body.length).toBeLessThanOrEqual(BIBLE_FACT_PIECE_MAX_CHARS + 'Formative wound: '.length);
            // Every piece opens at a paragraph (the header, then its label, then the paragraph's first words).
            expect(body).toMatch(/^Formative wound: (Wren keeps the lock at Harrow Weir\. )?Wren remembers the winter of the flood, part \d+\./);
        }
        const facts = await runInWorkspaceContext(ctx, (db) => db.storyFact.findMany({ where: { workspaceId: ctx.workspaceId, bookId }, select: { statement: true, quoteStart: true } }));
        expect(facts.filter((f) => f.statement === 'Wren keeps the lock at Harrow Weir.')).toHaveLength(1);
        // One fact from each call's first part: the calls really were separate pieces.
        expect(facts.filter((f) => f.statement.startsWith('Wren remembers')).length).toBe(sent.length);
        const row = (await rows(ctx, bookId))[0];
        expect(row.costMicroUsd).toBe(BigInt(7 * sent.length));
    });

    it('a version whose smallest call still has a worst case past the budget sends nothing (CALL_OVER_BUDGET)', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Too Dear' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren wants to cross the river before the spring floods.' });
        const [row] = await rows(ctx, bookId);
        await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.markQueued(db, ctx.workspaceId, row.id, new Date(), ANY_DUE));
        const calls = { n: 0 };
        const r = await executeBibleFactExtraction(
            { workspaceId: ctx.workspaceId, extractionId: row.id },
            { extractor: scripted(() => ({ facts: [] }), calls), charge: unlimited, gate, worstCase: () => BIBLE_FACTS_CALL_COST_BUDGET_MICRO_USD + 1 },
        );
        expect(r.outcome).toBe('CALL_OVER_BUDGET');
        expect(calls.n).toBe(0);
        expect((await rows(ctx, bookId))[0]).toMatchObject({ status: 'SKIPPED', outcome: 'CALL_OVER_BUDGET', costMicroUsd: BigInt(0) });
    });
});

describe('owner decisions of 2026-11-21: a cleared field is asked again at once', () => {
    it('a live bible fact whose quote left its entry stops answering the frontier at once; the fact itself waits for the author', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Cleared' })).id;
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', fields: [{ key: 'role', value: 'The lock keeper’s daughter' }] });
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: wren.id, depth: 5, detail: 3 }, { generator: fakeGenerator(), embedder: null });
        await updateElement(ctx, bookId, wren.id, { summary: 'Wren wants to cross the river before the spring floods.', baseVersion: 1 });
        await extractAll(ctx);
        expect((await frontierFor(ctx, bookId, view, wren.id)).answeredBy.want).toBe('bible-facts');
        // The author takes the sentence out. No extraction has run yet: the frontier reads the entry as it stands.
        await updateElement(ctx, bookId, wren.id, { summary: 'Wren keeps the lock at Harrow Weir.', baseVersion: 2 });
        const now = await frontierFor(ctx, bookId, view, wren.id);
        expect(now.asks).toContain('want');
        expect(now.answeredBy.want).toBeUndefined();
        // The fact is still live: only the author retires it, through the NO_LONGER_STATED proposal (rule 1).
        const want = (await bibleFacts(bookId)).find((f) => f.predicate === 'WANT')!;
        expect(want.supersededAt).toBeNull();
        await extractAll(ctx);
        const proposals = await listFactProposals(ctx, bookId);
        expect(proposals.proposals.some((p) => p.reason === 'NO_LONGER_STATED' && p.older.id === want.id)).toBe(true);
        expect((await bibleFacts(bookId)).find((f) => f.id === want.id)!.supersededAt).toBeNull();
    });
});

describe('review of 4.1, hardening: a round whose context cannot be read', () => {
    async function setup() {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Context' })).id;
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren keeps the lock at Harrow Weir.' });
        return { ctx, bookId, wren };
    }
    const roundsOf = (ctx: Ctx, sessionId: string) => runWithoutRls({ reason: 'test' }, (db) => db.interviewRound.findMany({ where: { workspaceId: ctx.workspaceId, sessionId }, select: { status: true } }));

    it('a vector search that fails reads the context lexically, and the round opens', async () => {
        const { ctx, bookId, wren } = await setup();
        const store = getVectorRepository();
        const original = store.search.bind(store);
        const spy = jest.spyOn(store, 'search').mockImplementation(async (db, ws, q) => {
            if (q.within) throw new Error('vector store down');
            return original(db, ws, q);
        });
        try {
            const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: wren.id, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: embedderFrom(new StubEmbeddingProvider()) });
            expect(view.round?.status).toBe('OPEN');
            expect(spy.mock.calls.some(([, , q]) => q.within !== undefined)).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });

    it('a context that cannot be read at all FAILS the claimed round, never leaving it GENERATING', async () => {
        const { ctx, bookId, wren } = await setup();
        let failNow = false;
        const real = BibleFactRepository.listLiveAbout.bind(BibleFactRepository);
        const spy = jest.spyOn(BibleFactRepository, 'listLiveAbout').mockImplementation(async (...args) => {
            if (failNow) throw new Error('database gone');
            return real(...args);
        });
        const stub = embedderFrom(new StubEmbeddingProvider());
        // The context query is embedded after the claim and before the context is read: from then on the read fails.
        const embedder: QuestionEmbedder = { revision: stub.revision, embed: async (texts) => { failNow = true; return stub.embed(texts); } };
        try {
            await expect(startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: wren.id, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder })).rejects.toThrow('database gone');
        } finally {
            spy.mockRestore();
        }
        const session = await runWithoutRls({ reason: 'test' }, (db) => db.interviewSession.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId, bookId }, select: { id: true, status: true } }));
        expect((await roundsOf(ctx, session.id)).map((r) => r.status)).toEqual(['FAILED']);
    });
});

describe('review of 4.1, hardening: what the database holds', () => {
    it('app_user cannot delete a provenance row; the cascade from a deleted element still takes it', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Provenance' })).id;
        const { elementId } = await seedFactLayer(ctx, bookId, 'Pv');
        const count = () => runWithoutRls({ reason: 'test' }, (db) => db.storyFactProvenance.count({ where: { workspaceId: ctx.workspaceId } }));
        expect(await count()).toBeGreaterThan(0);
        await expect(runInWorkspaceContext(ctx, (db) => db.storyFactProvenance.deleteMany({ where: { workspaceId: ctx.workspaceId } }))).rejects.toThrow(/permission denied/i);
        expect(await count()).toBeGreaterThan(0);
        await deleteElement(ctx, bookId, elementId);
        expect(await count()).toBe(0);
    });

    it('an invalidation keeps naming its newer fact: cleared only by the newer fact’s deletion', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Pointer' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren is 12 years old.' });
        await extractAll(ctx, age(12));
        const wren = (await bibleFacts(bookId))[0].elementId!;
        await updateElement(ctx, bookId, wren, { summary: 'Wren is 13 years old.', baseVersion: 1 });
        await extractAll(ctx, age(13));
        const p = (await listFactProposals(ctx, bookId)).proposals[0];
        await decideFactProposal(ctx, bookId, p.id, { decision: 'INVALIDATE' });
        await expect(runInWorkspaceContext(ctx, (db) => db.storyFact.updateMany({ where: { workspaceId: ctx.workspaceId, id: p.older.id }, data: { invalidatedByFactId: null } }))).rejects.toThrow(/STORY_FACT_FIXED/);
        expect((await bibleFacts(bookId)).find((f) => f.id === p.older.id)!.invalidatedByFactId).toBe(p.newer!.id);
        // The newer fact deleted: the foreign key's SET NULL passes, the older stays superseded.
        await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.delete({ where: { id: p.newer!.id } }));
        const older = (await bibleFacts(bookId)).find((f) => f.id === p.older.id)!;
        expect(older.invalidatedByFactId).toBeNull();
        expect(older.supersededAt).not.toBeNull();
    });
});
