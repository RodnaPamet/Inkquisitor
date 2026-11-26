/**
 * CONTINUITY END TO END (Phase 4.2, D28), against a real PostgreSQL. Every
 * model step is a scripted checker or extractor; nothing reaches a network.
 *
 *   contradictions are PROPOSED (rules, the deep check), never resolved, and
 *   shown with both sources; the author keeps the newer or the older, says both
 *   are true and explains (a fact), or rejects
 *   threads proposed by the bible fact extraction, accepted or rejected, a
 *   promise paid off, threads by hand; DECIDE_LATER answers feed open questions
 *   stale flags: direct citations only, cleared by the entry's next save,
 *   dismissed; "grill me on what changed" opens a scoped session
 *   the nightly check: changed books only, bounded, paged, resumable; the
 *   ceiling and the kill switch stop it resumably; D11 leaves the rules
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, updateElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { recordVersion } from '@/app-layer/usecases/bible-common';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { decideFactProposal } from '@/app-layer/usecases/fact-proposals';
import { createThread, decideThreadProposal, deleteThread, dismissStaleFlag, getContinuityPage, updateThread } from '@/app-layer/usecases/continuity';
import { executeContinuityDispatch } from '@/app-layer/usecases/continuity-dispatch';
import { decideFact, listBookFacts } from '@/app-layer/usecases/source-facts';
import { dispatchIngestion, uploadSource } from '@/app-layer/usecases/source-library';
import { executeSourceIngest } from '@/app-layer/usecases/source-ingest';
import { startInterview } from '@/app-layer/usecases/interviews';
import { decideLater } from '@/app-layer/usecases/interview-answers';
import { loadInterviewState, requireSession } from '@/app-layer/usecases/interview-state';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { AppError } from '@/lib/errors/types';
import type { FactExtractor } from '@/lib/sources/extractor';
import { CLEAN_SCAN } from '../helpers/research';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { ageExtractor, extractPending } from '../helpers/facts';
import { answerAbout, citeAnswers, runNight, threadExtractor } from '../helpers/continuity';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

type Ctx = ReturnType<typeof workspaceCtx>;

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, reason: (err.details as { reason?: unknown } | undefined)?.reason };
        throw err;
    }
    throw new Error('expected a refusal');
}

const quiet = () => ({ extract: async () => ({ ok: true as const, output: { contradictions: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] as string[] }) });

async function proposals(bookId: string) {
    return runWithoutRls({ reason: 'test' }, (db) => db.storyFactProposal.findMany({ where: { bookId }, orderBy: { createdAt: 'asc' }, select: { id: true, factId: true, newerFactId: true, reason: true, basis: true, kind: true, status: true, checkRunId: true } }));
}

async function ageFacts(ctx: Ctx, bookId: string, names: readonly string[]): Promise<string[]> {
    // One at a time: an extraction runs every pending row with the extractor it is handed.
    for (const name of names) {
        await createElement(ctx, bookId, { kind: 'CHARACTER', name, summary: `${name} is 30 years old.` });
        await extractPending(ctx, bookId, ageExtractor(name));
    }
    const facts = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findMany({ where: { bookId, sourceKind: 'BIBLE_VERSION', predicate: 'AGE' }, orderBy: { createdAt: 'asc' }, select: { id: true } }));
    return facts.map((f) => f.id);
}

/** A source fact of the book's own library, confirmed by the author: one AGE about `name`. */
async function confirmedSourceAge(ctx: Ctx, bookId: string, name: string, age: number): Promise<void> {
    const sentence = `${name} is ${age} years old.`;
    const extractor: FactExtractor = {
        async extract() {
            return { ok: true, output: { facts: [{ subject: name, predicate: 'AGE', object: `${age} years old`, statement: sentence, quote: sentence, storyTimeFrom: '', storyTimeTo: '' }] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
        },
    };
    const undo = setFakeApiKey();
    try {
        const source = await uploadSource(ctx, { kind: 'book', bookId }, { bytes: new TextEncoder().encode(`Chapter one.\n\n${sentence}`), filename: `notes-${age}.txt` }, { scan: CLEAN_SCAN });
        await dispatchIngestion(ctx, source.id, { confirmWorstCaseMicroUsd: source.worstCaseMicroUsd }, { enqueue: async () => undefined });
        await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: source.id }, { extractor: () => extractor, embedder: () => new StubEmbeddingProvider() });
    } finally {
        undo();
    }
    const fact = (await listBookFacts(ctx, bookId)).facts.find((f) => f.statement === sentence)!;
    await decideFact(ctx, fact.id, 'CONFIRM');
}

describe('contradictions: proposed, never resolved, shown with both sources', () => {
    it('the nightly rules find what a later confirmed source fact contradicts; both facts stay live, and the page shows both sources', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'The Weir' })).id;
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren is 12 years old.' });
        await extractPending(ctx, bookId, ageExtractor('Wren'));
        await confirmedSourceAge(ctx, bookId, 'Wren', 14);
        // The extraction ran before the source fact was confirmed: nothing compared them yet.
        expect(await proposals(bookId)).toEqual([]);

        expect(await runNight(ctx, { checker: quiet })).toEqual(['OK']);
        const [p] = await proposals(bookId);
        expect(p).toMatchObject({ reason: 'CONTRADICTED', basis: 'RULE', kind: 'VALUE', status: 'PENDING' });
        expect(p.checkRunId).not.toBeNull();
        const live = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findMany({ where: { id: { in: [p.factId, p.newerFactId!] } }, select: { supersededAt: true } }));
        expect(live.every((f) => f.supersededAt === null)).toBe(true);

        const page = await getContinuityPage(ctx, bookId);
        expect(page.assessed).toBe(true);
        expect(page.contradictions.items).toHaveLength(1);
        const c = page.contradictions.items[0];
        expect(new Set([c.older.origin.kind, c.newer!.origin.kind])).toEqual(new Set(['ELEMENT', 'SOURCE']));
        expect(c.kind).toBe('VALUE');

        // Nothing changed since the pass: the next night queues nothing, and asks nothing again.
        expect(await runNight(ctx, { checker: quiet })).toEqual([]);
        expect(await proposals(bookId)).toHaveLength(1);
    });

    it('a book with no live fact reads "not assessed" (rule 6), never clean', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Empty' })).id;
        const page = await getContinuityPage(ctx, bookId);
        expect(page).toMatchObject({ assessed: false, liveFacts: 0 });
        expect(page.nightly.lastRunAt).toBeNull();
    });

    it('the deep check proposes its pairs (basis DEEP), each with its kind, once; the author decides every one', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Deep' })).id;
        await ageFacts(ctx, bookId, ['Arla', 'Bram']);
        const pair = () => ({ extract: async () => ({ ok: true as const, output: { contradictions: [{ first: 1, second: 2, kind: 'TIMELINE' }, { first: 1, second: 9, kind: 'VALUE' }] }, tokensUsed: 1, costMicroUsd: 5, callIds: [] as string[] }) });
        expect(await runNight(ctx, { checker: pair })).toEqual(['OK']);
        const raised = await proposals(bookId);
        expect(raised).toHaveLength(1);
        expect(raised[0]).toMatchObject({ basis: 'DEEP', kind: 'TIMELINE', status: 'PENDING' });
        const run = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.findFirstOrThrow({ where: { bookId }, orderBy: { createdAt: 'desc' } }));
        expect(run).toMatchObject({ status: 'DONE', outcome: 'OK', callsMade: 1, deepProposals: 1 });
        expect(Number(run.costMicroUsd)).toBe(5);
        expect((run.metrics as { refusals: Record<string, number> }).refusals.UNKNOWN_FACT).toBe(1);
    });
});

describe('resolving a contradiction', () => {
    it('keep the older, keep the newer, both true with an explanation that becomes a fact, or not a contradiction; a reader decides nothing', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Decide' })).id;
        const [f1, f2, f3, f4, f5, f6] = await ageFacts(ctx, bookId, ['Ada', 'Bea', 'Cal', 'Dov', 'Eli', 'Fen']);
        const raise = (factId: string, newerFactId: string) =>
            runWithoutRls({ reason: 'test' }, (db) => db.storyFactProposal.create({ data: { workspaceId: ctx.workspaceId, bookId, factId, newerFactId, reason: 'CONTRADICTED', basis: 'RULE', kind: 'VALUE' }, select: { id: true } }));
        const p1 = await raise(f1, f2);
        const p2 = await raise(f3, f4);
        const p3 = await raise(f5, f6);
        const p4 = await raise(f3, f5);

        const reader = { ...ctx, role: 'READER' as const, permissions: { ...ctx.permissions, bible: { ...ctx.permissions.bible, edit: false } } };
        expect((await refusal(decideFactProposal(reader, bookId, p1.id, { decision: 'INVALIDATE_NEWER' }))).status).toBe(403);

        // Keep the older: the newer is set aside, named by the older.
        await decideFactProposal(ctx, bookId, p1.id, { decision: 'INVALIDATE_NEWER' });
        const after1 = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findMany({ where: { id: { in: [f1, f2] } }, select: { id: true, supersededAt: true, invalidatedByFactId: true } }));
        expect(after1.find((f) => f.id === f1)!.supersededAt).toBeNull();
        expect(after1.find((f) => f.id === f2)).toMatchObject({ invalidatedByFactId: f1 });

        // Both true: an explanation is required, sanitised, and kept as a fact naming the proposal; both facts stay live.
        expect((await refusal(decideFactProposal(ctx, bookId, p2.id, { decision: 'KEEP_BOTH' }))).reason).toBe('EXPLANATION_REQUIRED');
        const kept = await decideFactProposal(ctx, bookId, p2.id, { decision: 'KEEP_BOTH', explanation: 'Cal lies about his age <script>x</script> to the guild.' });
        expect(kept.status).toBe('KEPT');
        // Read in the workspace's context: the statement is encrypted at rest.
        const explanation = await runInWorkspaceContext(ctx, (db) => db.storyFact.findUniqueOrThrow({ where: { id: kept.explanationFactId! }, select: { sourceKind: true, status: true, automatic: true, statement: true, resolvesProposalId: true, decidedById: true } }));
        expect(explanation).toMatchObject({ sourceKind: 'AUTHOR_RESOLUTION', status: 'CONFIRMED', automatic: false, resolvesProposalId: p2.id, decidedById: ctx.userId });
        expect(explanation.statement).toContain('Cal lies about his age');
        expect(explanation.statement).not.toContain('<script');
        const both = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findMany({ where: { id: { in: [f3, f4] } }, select: { supersededAt: true } }));
        expect(both.every((f) => f.supersededAt === null)).toBe(true);

        // Keep the newer: the older goes, and every other pending contradiction it stands in is settled with it.
        await decideFactProposal(ctx, bookId, p3.id, { decision: 'INVALIDATE' });
        const settled = (await proposals(bookId)).find((p) => p.id === p4.id)!;
        expect(settled.status).toBe('INVALIDATED_NEWER');
        expect((await refusal(decideFactProposal(ctx, bookId, p3.id, { decision: 'REJECT' }))).reason).toBe('PROPOSAL_DECIDED');

        const page = await getContinuityPage(ctx, bookId);
        expect(page.contradictions.items).toEqual([]);
    });
});

describe('the registries: proposed and accepted, and by hand', () => {
    it('a thread drawn from a saved entry is proposed citing it; accepted, rejected (never again), and a promise paid off', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Threads' })).id;
        const vow = 'Pell swears to find whoever forged the harbour deed.';
        const pell = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Pell', summary: vow });
        await extractPending(ctx, bookId, threadExtractor(vow, 'Pell will find whoever forged the harbour deed'));
        let page = await getContinuityPage(ctx, bookId);
        expect(page.threadProposals.items).toHaveLength(1);
        const proposal = page.threadProposals.items[0];
        expect(proposal).toMatchObject({ op: 'NEW_THREAD', kind: 'PROMISE', quote: vow, elementName: 'Pell', versionNumber: 1 });
        // Rule 1: nothing is a thread until the author accepts.
        expect(page.threads.items).toEqual([]);
        const accepted = await decideThreadProposal(ctx, bookId, proposal.id, { decision: 'ACCEPT' });
        page = await getContinuityPage(ctx, bookId);
        expect(page.threads.items).toEqual([expect.objectContaining({ id: accepted.threadId, kind: 'PROMISE', state: 'OPEN', subjectName: 'Pell' })]);

        // The same claim saved again is never proposed again (one proposal per claim, ever).
        await updateElement(ctx, bookId, pell.id, { summary: `${vow} He is tired.`, baseVersion: 1 });
        await extractPending(ctx, bookId, threadExtractor(vow, 'Pell will find whoever forged the harbour deed'));
        expect((await getContinuityPage(ctx, bookId)).threadProposals.items).toEqual([]);

        // A rejected one is never proposed again either.
        const clue = 'Pell keeps an ink-stained ledger.';
        await updateElement(ctx, bookId, pell.id, { summary: clue, baseVersion: 2 });
        await extractPending(ctx, bookId, threadExtractor(clue, 'An ink-stained ledger'));
        const second = (await getContinuityPage(ctx, bookId)).threadProposals.items[0];
        await decideThreadProposal(ctx, bookId, second.id, { decision: 'REJECT' });
        await updateElement(ctx, bookId, pell.id, { summary: `${clue} Still.`, baseVersion: 3 });
        await extractPending(ctx, bookId, threadExtractor(clue, 'An ink-stained ledger'));
        expect((await getContinuityPage(ctx, bookId)).threadProposals.items).toEqual([]);

        // A later entry pays the promise off, citing where: the call is shown the open thread and names it.
        const payoff = 'Pell unmasks the clerk who forged the harbour deed.';
        const seen: string[] = [];
        const paying = (): FactExtractor => ({
            async extract(request) {
                const open = request.data.find((b) => b.label === 'open-threads')?.text ?? '';
                seen.push(open);
                const text = request.data.find((b) => b.label === 'entry.text')?.text ?? '';
                return { ok: true, output: { facts: [], threads: text.includes(payoff) && open.includes('[PROMISE]') ? [{ kind: 'PROMISE', title: '', quote: payoff, paysOff: 1 }] : [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
            },
        });
        await updateElement(ctx, bookId, pell.id, { summary: payoff, baseVersion: 4 });
        await extractPending(ctx, bookId, paying);
        expect(seen.some((s) => s.includes('Pell will find whoever forged the harbour deed'))).toBe(true);
        const pay = (await getContinuityPage(ctx, bookId)).threadProposals.items[0];
        expect(pay).toMatchObject({ op: 'SET_STATE', proposedState: 'PAID_OFF', threadId: accepted.threadId, quote: payoff });
        await decideThreadProposal(ctx, bookId, pay.id, { decision: 'ACCEPT' });
        expect((await getContinuityPage(ctx, bookId)).threads.items[0]).toMatchObject({ state: 'PAID_OFF' });
        expect((await refusal(decideThreadProposal(ctx, bookId, pay.id, { decision: 'ACCEPT' }))).reason).toBe('PROPOSAL_DECIDED');
    });

    it('by hand: added, edited against its version, a state its kind allows, removed; a reader adds nothing', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'By hand' })).id;
        const t = await createThread(ctx, bookId, { kind: 'CLUE', title: 'A wet boot <b>by</b> the door', note: 'Planted in chapter two.' });
        expect(t).toMatchObject({ kind: 'CLUE', state: 'OPEN', version: 1, title: 'A wet boot by the door' });
        expect((await refusal(updateThread(ctx, bookId, t.id, { baseVersion: 1, state: 'PAID_OFF' }))).reason).toBe('STATE_NOT_ALLOWED');
        const revealed = await updateThread(ctx, bookId, t.id, { baseVersion: 1, state: 'REVEALED' });
        expect(revealed).toMatchObject({ state: 'REVEALED', version: 2 });
        expect((await refusal(updateThread(ctx, bookId, t.id, { baseVersion: 1, title: 'Stale' }))).reason).toBe('VERSION_CONFLICT');
        expect((await refusal(deleteThread(ctx, bookId, t.id, '1'))).reason).toBe('VERSION_CONFLICT');
        await deleteThread(ctx, bookId, t.id, '2');
        expect((await getContinuityPage(ctx, bookId)).threads.items).toEqual([]);
        const reader = { ...ctx, role: 'READER' as const, permissions: { ...ctx.permissions, bible: { ...ctx.permissions.bible, edit: false } } };
        expect((await refusal(createThread(reader, bookId, { kind: 'PROMISE', title: 'No' }))).status).toBe(403);
    });

    it('a "decide later" answer is an open question until its field is filled', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Later' })).id;
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren' });
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: wren.id, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder });
        const q = view.round!.questions[0];
        await decideLater(ctx, bookId, view.session.id, q.id);
        let page = await getContinuityPage(ctx, bookId);
        expect(page.decideLater.items).toEqual([expect.objectContaining({ elementId: wren.id, elementName: 'Wren', fieldKeys: q.targetsFieldKeys })]);
        await updateElementFields(ctx, bookId, wren.id, { baseVersion: 1, fields: q.targetsFieldKeys.map((key) => ({ key, value: 'The lock keeper, decided now.' })) });
        page = await getContinuityPage(ctx, bookId);
        expect(page.decideLater.items).toEqual([]);
    });
});

describe('propagation debt: direct citations only', () => {
    async function scene(ctx: Ctx, bookId: string) {
        const premise = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Marrow', summary: 'Marrow keeps the mill.' });
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren hates Marrow.' });
        await updateElementFields(ctx, bookId, wren.id, { fields: [{ key: 'want', value: 'To see Marrow answer for the mill.' }], baseVersion: wren.versionNumber });
        const ilse = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ilse', summary: 'Ilse trusts Wren.' });
        // Wren's entry drew on an answer about Marrow; Ilse's on an answer about Wren (not about Marrow).
        await citeAnswers(ctx, bookId, wren.id, [await answerAbout(ctx, bookId, premise.id, 'Marrow burned the mill.')]);
        await citeAnswers(ctx, bookId, ilse.id, [await answerAbout(ctx, bookId, wren.id, 'Wren saved her once.')]);
        return { premise, wren, ilse };
    }

    it('a change flags the entries that cited it and no others; the entry’s next save clears it; a reorder raises nothing; a dismissal holds until the next change', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Debt' })).id;
        const { premise, wren } = await scene(ctx, bookId);
        expect((await getContinuityPage(ctx, bookId)).stale.items).toEqual([]);

        await updateElement(ctx, bookId, premise.id, { summary: 'Marrow is innocent after all.', baseVersion: 1 });
        let stale = (await getContinuityPage(ctx, bookId)).stale.items;
        // Wren cited Marrow; Ilse cited Wren, not Marrow: no transitive spread.
        expect(stale.map((f) => [f.elementName, f.upstreamName])).toEqual([['Wren', 'Marrow']]);
        expect(stale[0]).toMatchObject({ fromVersion: 1, toVersion: 2 });

        // Wren is saved again: its flag clears, and that save is itself a change Ilse cited (one hop, not a spread).
        const wrenVersion = (await runWithoutRls({ reason: 'test' }, (db) => db.bibleEntryVersion.count({ where: { elementId: wren.id } })));
        await updateElement(ctx, bookId, wren.id, { summary: 'Wren no longer knows what to think of Marrow.', baseVersion: wrenVersion });
        const pairs = async () => (await getContinuityPage(ctx, bookId)).stale.items.map((f) => [f.elementName, f.upstreamName]);
        const fromMarrow = async () => (await getContinuityPage(ctx, bookId)).stale.items.filter((f) => f.upstreamName === 'Marrow');
        expect(await pairs()).toEqual([['Ilse', 'Wren']]);

        // A reorder-like save of Marrow (movedInOrder) changes nothing a citation rests on.
        await runInWorkspaceContext(ctx, async (db) => {
            await BibleElementRepository.lock(db, premise.id);
            await recordVersion(db, ctx, bookId, premise.id, { source: 'MANUAL', movedInOrder: true });
        });
        expect(await pairs()).toEqual([['Ilse', 'Wren']]);

        // Marrow changes again: Wren is flagged again, from that change; dismissing holds until the next one.
        await updateElement(ctx, bookId, premise.id, { summary: 'Marrow left the town.', baseVersion: 3 });
        stale = await fromMarrow();
        expect(stale.map((f) => f.elementName)).toEqual(['Wren']);
        expect(stale[0].fromVersion).toBe(3);
        await dismissStaleFlag(ctx, bookId, stale[0].id);
        expect(await fromMarrow()).toEqual([]);
        expect((await refusal(dismissStaleFlag(ctx, bookId, stale[0].id))).reason).toBe('FLAG_NOT_OPEN');
        await updateElement(ctx, bookId, premise.id, { summary: 'Marrow came back.', baseVersion: 4 });
        expect(await fromMarrow()).toHaveLength(1);
    });

    it('"grill me on what changed" opens an interview scoped to the stale entry, the change as its context, its fields challenged', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Grill' })).id;
        const { premise, wren, ilse } = await scene(ctx, bookId);
        await updateElement(ctx, bookId, premise.id, { summary: 'Marrow is innocent after all.', baseVersion: 1 });
        const [flag] = (await getContinuityPage(ctx, bookId)).stale.items;

        // Another element, or a flag that is not this entry's, is refused.
        expect((await refusal(startInterview(ctx, bookId, { scope: 'SELECTION', elementIds: [ilse.id], staleFlagId: flag.id }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder }))).reason).toBe('STALE_FLAG_GONE');

        const generator = fakeGenerator();
        const view = await startInterview(ctx, bookId, { scope: 'SELECTION', elementIds: [wren.id], staleFlagId: flag.id, depth: 2 }, { generator, embedder: stubQuestionEmbedder });
        const session = await runWithoutRls({ reason: 'test' }, (db) => db.interviewSession.findUniqueOrThrow({ where: { id: view.session.id }, select: { scope: true, scopeElementIds: true, staleFlagId: true, depth: true } }));
        expect(session).toEqual({ scope: 'SELECTION', scopeElementIds: [wren.id], staleFlagId: flag.id, depth: 5 });
        // The change reaches the question generator as one fenced data block, and Wren's filled field is offered as a challenge.
        const blocks = new Map(generator.calls[0].data.map((b) => [b.label, b.text] as const));
        expect(blocks.get('upstream-change')).toContain('was "');
        expect(blocks.get('upstream-change')).toContain('Marrow is innocent after all.');
        const targets = [...blocks].filter(([l]) => l.startsWith('targets.')).map(([, t]) => JSON.parse(t) as { elementId: string; may_challenge: string | null });
        expect(targets.find((t) => t.elementId === wren.id)?.may_challenge).toBeTruthy();
        const state = await runInWorkspaceContext(ctx, async (db) => loadInterviewState(db, ctx, await requireSession(db, ctx, bookId, view.session.id)));
        expect(state.stale).toMatchObject({ elementId: wren.id });
        expect(state.stale!.fieldKeys.length).toBeGreaterThan(0);
    });
});

describe('the nightly check', () => {
    const counting = (calls: { n: number }) => () => ({
        extract: async () => {
            calls.n++;
            return { ok: true as const, output: { contradictions: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] as string[] };
        },
    });

    it('runs over changed books only, bounded a night, paging through a large book across nights from its cursor', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Large' })).id;
        const quietBook = (await createBook(ctx, { title: 'Quiet' })).id;
        await ageFacts(ctx, bookId, ['Ana', 'Ben', 'Cy', 'Dee', 'Eve']);
        const calls = { n: 0 };
        const night = () => runNight(ctx, { checker: counting(calls), callsPerNight: 1, factsPerCall: 2 });
        // Five subjects of one fact each, at most two facts a call and one call a night: three nights.
        expect(await night()).toEqual(['PAGED']);
        expect(await night()).toEqual(['PAGED']);
        expect(await night()).toEqual(['OK']);
        expect(calls.n).toBe(3);
        const runs = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.findMany({ where: { workspaceId: ctx.workspaceId }, select: { bookId: true, subjectsCovered: true } }));
        // The quiet book (no facts, never changed) was never queued.
        expect(runs.every((r) => r.bookId === bookId)).toBe(true);
        expect(runs.reduce((n, r) => n + r.subjectsCovered, 0)).toBe(5);
        expect(quietBook).toBeTruthy();
        // Unchanged since: nothing queued. A new fact: queued again, and only its subject is paged.
        expect(await night()).toEqual([]);
        await ageFacts(ctx, bookId, ['Fay']);
        expect(await night()).toEqual(['OK']);
        expect(calls.n).toBe(4);
    });

    it('stops resumably at the ceiling and the kill switch, never as a failure, and resumes from its cursor; D11 still runs the rules', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Stops' })).id;
        await ageFacts(ctx, bookId, ['Gus', 'Hal']);
        await confirmedSourceAge(ctx, bookId, 'Gus', 70);
        const failing = (failure: 'WORKSPACE_CEILING' | 'KILL_SWITCH') => () => ({ extract: async () => ({ ok: false as const, failure, errorCode: failure, tokensUsed: 0, costMicroUsd: 0, callIds: [] as string[] }) });

        // D11: no record this deployment accepts — the rules run (a proposal), the deep step waits, the pass stays open.
        expect(await runNight(ctx, { gate: () => ({ mounted: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: '' }) })).toEqual(['NOT_EVALUATED']);
        expect((await proposals(bookId)).map((p) => p.basis)).toEqual(['RULE']);
        const state = () => runWithoutRls({ reason: 'test' }, (db) => db.continuityCheck.findFirstOrThrow({ where: { bookId }, select: { passTarget: true, passCursor: true, coveredThrough: true } }));
        expect((await state()).passTarget).not.toBeNull();

        expect(await runNight(ctx, { checker: failing('WORKSPACE_CEILING'), callsPerNight: 1, factsPerCall: 2 })).toEqual(['CEILING']);
        expect(await runNight(ctx, { checker: failing('KILL_SWITCH'), callsPerNight: 1, factsPerCall: 2 })).toEqual(['KILL_SWITCH']);
        const stopped = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.findMany({ where: { bookId, outcome: { in: ['CEILING', 'KILL_SWITCH'] } }, select: { status: true } }));
        expect(stopped.map((r) => r.status)).toEqual(['STOPPED', 'STOPPED']);
        expect((await state()).coveredThrough).toBeNull();

        const calls = { n: 0 };
        expect(await runNight(ctx, { checker: counting(calls), callsPerNight: 1, factsPerCall: 2 })).toEqual(['PAGED']);
        expect(await runNight(ctx, { checker: counting(calls), callsPerNight: 1, factsPerCall: 2 })).toEqual(['OK']);
        expect((await state())).toMatchObject({ passTarget: null, passCursor: null });
        expect((await state()).coveredThrough).not.toBeNull();
        // The rule proposal was not raised a second time on any of those nights.
        expect((await proposals(bookId)).filter((p) => p.basis === 'RULE')).toHaveLength(1);
        const failed = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.count({ where: { bookId, status: 'FAILED' } }));
        expect(failed).toBe(0);
    });

    it('a run lost by its worker is ended and the book queued again', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Lost' })).id;
        await ageFacts(ctx, bookId, ['Ivo']);
        const lost = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.create({ data: { workspaceId: ctx.workspaceId, bookId, status: 'RUNNING', createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000) }, select: { id: true } }));
        const r = await executeContinuityDispatch({ enqueue: async () => undefined, workspaceIds: [ctx.workspaceId] });
        expect(r).toMatchObject({ due: 1, queued: 1, expired: 1 });
        const row = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.findUniqueOrThrow({ where: { id: lost.id }, select: { status: true, outcome: true } }));
        expect(row).toEqual({ status: 'STOPPED', outcome: 'CLAIM_EXPIRED' });
    });
});

describe('isolation', () => {
    it('another workspace’s book reads as missing; its threads and flags are never listed', async () => {
        const a = await createAccount();
        const b = await createAccount();
        const ctxA = workspaceCtx(a);
        const ctxB = workspaceCtx(b);
        const bookA = (await createBook(ctxA, { title: 'A' })).id;
        await createThread(ctxA, bookA, { kind: 'PROMISE', title: 'Only in A' });
        expect((await refusal(getContinuityPage(ctxB, bookA))).status).toBe(404);
        expect((await refusal(createThread(ctxB, bookA, { kind: 'PROMISE', title: 'Into A' }))).status).toBe(404);
        const seen = await runInWorkspaceContext(ctxB, (db) => db.storyThread.count({ where: { bookId: bookA } }));
        expect(seen).toBe(0);
    });
});
