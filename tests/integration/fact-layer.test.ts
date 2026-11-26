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
        await decideFactProposal(ctx, bookId, p.id, { decision: 'KEEP_BOTH' });
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
        await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.markQueued(db, ctx.workspaceId, row.id, new Date()));
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

        await runInWorkspaceContext(ctx, (db) => FactExtractionRepository.markQueued(db, ctx.workspaceId, id, new Date()));
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
