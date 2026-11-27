/**
 * THE DRAFT HELD AGAINST THE BIBLE (Phase 5.3, D35), end to end against the real database: the nightly reading of a
 * scene (dispatch, then the job) with a scripted reader — no model, no network — the mismatch it raises, the author's
 * three choices, the plant / pay-off links, the combined nightly share, the scene card and "Grill me on this scene".
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene, deleteScene } from '@/app-layer/usecases/manuscript';
import { saveSceneText } from '@/app-layer/usecases/manuscript-scenes';
import { createThread, getContinuityPage } from '@/app-layer/usecases/continuity';
import { executeDraftReadDispatch } from '@/app-layer/usecases/draft-read-dispatch';
import { executeDraftRead, type DraftReadDeps } from '@/app-layer/usecases/draft-read';
import { decideDraftMismatch, getDraftUpdatePrefill, getSceneDraftNotes, updateBibleFromDraft } from '@/app-layer/usecases/draft-mismatches';
import { decideThreadSceneLink } from '@/app-layer/usecases/thread-scene-links';
import { getSceneCard, saveSceneCard } from '@/app-layer/usecases/scene-card';
import { getInterview, startInterview } from '@/app-layer/usecases/interviews';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { closeRoundAndReconcile } from '@/app-layer/usecases/enrichment-reconcile';
import { acceptProposal, getSessionReview } from '@/app-layer/usecases/enrichment-review';
import { sceneSubjectId } from '@/lib/interview/subjects';
import type { FactExtractor } from '@/lib/sources/extractor';
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { extractPending } from '../helpers/facts';
import { nextTestNight } from '../helpers/continuity';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { scripted } from '../helpers/enrichment';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

/** A scripted bible fact extractor: "<Name> has <colour> eyes" in an entry is an APPEARANCE fact. */
function eyesExtractor(name: string): () => FactExtractor {
    return () => ({
        async extract(request) {
            const text = request.data.find((b) => b.label === 'entry.text')?.text ?? '';
            const m = new RegExp(`${name} has (\\w+) eyes`).exec(text);
            const facts = m ? [{ subject: name, predicate: 'APPEARANCE', object: `${m[1]} eyes`, statement: `${name} has ${m[1]} eyes.`, quote: m[0], storyTimeFrom: '', storyTimeTo: '', contradicts: [] }] : [];
            return { ok: true, output: { facts }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
        },
    });
}

const textOf = (blocks: readonly AuthorDataBlock[], label: string) => blocks.find((b) => b.label === label)?.text ?? '';

/**
 * A scripted draft reader: "<Name>'s <colour> eyes" in a scene is an APPEARANCE fact; a sentence naming a shown thread's
 * first word with "promised" plants it, with "kept" pays it off. Every request is kept.
 */
function draftReader(name: string, requests: Array<readonly AuthorDataBlock[]>): NonNullable<DraftReadDeps['reader']> {
    return () => ({
        async extract(request) {
            requests.push(request.data);
            const text = textOf(request.data, 'scene.text');
            const facts: unknown[] = [];
            const eyes = new RegExp(`${name}’s (\\w+) eyes`).exec(text);
            if (eyes) facts.push({ subject: name, predicate: 'APPEARANCE', object: `${eyes[1]} eyes`, statement: `${name} has ${eyes[1]} eyes.`, quote: eyes[0], storyTimeFrom: '', storyTimeTo: '' });
            const threads: unknown[] = [];
            textOf(request.data, 'threads')
                .split('\n')
                .filter((l) => l.trim() !== '')
                .forEach((line, i) => {
                    const word = /\] (\w+)/.exec(line)?.[1];
                    const promised = word ? new RegExp(`[^.]*promised[^.]*${word}[^.]*\\.`, 'i').exec(text) : null;
                    const kept = word ? new RegExp(`[^.]*kept[^.]*${word}[^.]*\\.`, 'i').exec(text) : null;
                    if (promised) threads.push({ thread: i + 1, role: 'PLANTS', quote: promised[0].trim() });
                    if (kept) threads.push({ thread: i + 1, role: 'PAYS', quote: kept[0].trim() });
                });
            return { ok: true, output: { facts, threads }, tokensUsed: 10, costMicroUsd: 10, callIds: [] };
        },
    });
}

afterAll(() => prisma.$disconnect());

const MOUNTED = () => ({ mounted: true as const, recordKind: 'structural' as const });

/** The night: the dispatcher queues the workspace's due books, then each run is executed with `deps`. */
async function readNight(ctx: WorkspaceRequestContext, deps: DraftReadDeps, nightKey = nextTestNight()): Promise<Array<string | null>> {
    const queued: string[] = [];
    await executeDraftReadDispatch({ enqueue: async (_name, payload) => void queued.push((payload as { runId: string }).runId), workspaceIds: [ctx.workspaceId], nightKey });
    const undo = setFakeApiKey();
    try {
        const out: Array<string | null> = [];
        for (const runId of queued) out.push((await executeDraftRead({ workspaceId: ctx.workspaceId, runId }, { charge: () => undefined, gate: MOUNTED, nightlyCapMicroUsd: 1_000_000_000, ...deps })).outcome);
        return out;
    } finally {
        undo();
    }
}

interface Fixture {
    ctx: WorkspaceRequestContext;
    bookId: string;
    maraId: string;
    sceneId: string;
    revision: number;
    threadId: string;
}

async function fixture(sceneHtml = '<p>Mara looked up at the lamp, Mara’s blue eyes wet. She promised to find the Key before the storm.</p>'): Promise<Fixture> {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title: 'The keeper' })).id;
    const mara = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara' });
    await updateElementFields(ctx, bookId, mara.id, { fields: [{ key: 'physical_presence', value: 'Mara has green eyes and a slow way of walking.' }], baseVersion: mara.versionNumber });
    await extractPending(ctx, bookId, eyesExtractor('Mara'));
    const thread = await createThread(ctx, bookId, { kind: 'PROMISE', title: 'Key to the lamp room', note: null });
    const chapterId = (await createChapter(ctx, bookId, { title: 'One' })).id;
    const sceneId = (await createScene(ctx, bookId, { chapterId, title: 'The lamp' })).id;
    const saved = await saveSceneText(ctx, bookId, sceneId, { html: sceneHtml, baseRevision: 0, checkpoint: true });
    return { ctx, bookId, maraId: mara.id, sceneId, revision: saved.revision, threadId: thread.id };
}

describe('the nightly reading of a scene (D35 items 1 and 2)', () => {
    it('reads a changed scene once, draws DRAFT facts (never canon), raises a mismatch citing both sentences, proposes the plant, and reads nothing unchanged again', async () => {
        const f = await fixture();
        const requests: Array<readonly AuthorDataBlock[]> = [];
        expect(await readNight(f.ctx, { reader: draftReader('Mara', requests) })).toEqual(['OK']);
        expect(requests).toHaveLength(1);

        const facts = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findMany({ where: { bookId: f.bookId, sourceKind: 'SCENE_TEXT' }, select: { id: true, status: true, decidedAt: true, sceneId: true, subjectElementId: true, supersededAt: true } }));
        expect(facts.map((x) => ({ status: x.status, decidedAt: x.decidedAt, sceneId: x.sceneId, subjectElementId: x.subjectElementId, supersededAt: x.supersededAt }))).toEqual([{ status: 'PENDING', decidedAt: null, sceneId: f.sceneId, subjectElementId: f.maraId, supersededAt: null }]);
        // A draft fact is never embedded (it is not canon, and it is not retrieved): no embedding task names it.
        expect(await runWithoutRls({ reason: 'test' }, (db) => db.embeddingTask.count({ where: { sourceModel: 'StoryFact', sourceId: facts[0].id } }))).toBe(0);

        const page = await getContinuityPage(f.ctx, f.bookId);
        expect(page.draft.reading).toMatchObject({ scenesWithText: 1, scenesRead: 1, scenesWaiting: 0 });
        expect(page.draft.mismatches.open).toBe(1);
        const m = page.draft.mismatches.items[0];
        expect(m).toMatchObject({ status: 'PENDING', kind: 'VALUE', sceneId: f.sceneId, canUpdateBible: true });
        expect(m.draft.quote).toBe('Mara’s blue eyes');
        expect(m.bible.quote).toBe('Mara has green eyes');
        expect(m.bible.elementId).toBe(f.maraId);
        // The draft's contradiction never reaches the ordinary contradiction list (it is decided with its own three choices).
        expect(page.contradictions.items.some((p) => p.id === m.id)).toBe(false);
        expect(page.draft.linkProposals.items).toEqual([expect.objectContaining({ threadId: f.threadId, role: 'PLANTS', status: 'PENDING', quote: 'She promised to find the Key before the storm.' })]);

        const notes = await getSceneDraftNotes(f.ctx, f.bookId, f.sceneId);
        expect(notes.readAtCurrentText).toBe(true);
        expect(notes.currentTextKeyMatches[m.id]).toBe(true);

        // Unchanged: tomorrow night reads nothing (no call), and nothing is raised twice.
        expect(await readNight(f.ctx, { reader: draftReader('Mara', requests) })).toEqual([]);
        expect(requests).toHaveLength(1);
        expect((await getContinuityPage(f.ctx, f.bookId)).draft.mismatches.open).toBe(1);
    });

    it('a manuscript never read says "not read yet" (rule 6), never "no mismatches"', async () => {
        const f = await fixture();
        const page = await getContinuityPage(f.ctx, f.bookId);
        expect(page.draft.reading).toMatchObject({ scenesWithText: 1, scenesRead: 0, scenesWaiting: 1, lastRunAt: null });
        expect(page.draft.mismatches.items).toEqual([]);
        const notes = await getSceneDraftNotes(f.ctx, f.bookId, f.sceneId);
        expect(notes).toMatchObject({ readAtCurrentText: false, everRead: false });
    });

    it('sends only the book’s own scene and names: another book’s canary never reaches a request', async () => {
        const f = await fixture();
        const other = (await createBook(f.ctx, { title: 'Elsewhere' })).id;
        await createElement(f.ctx, other, { kind: 'CHARACTER', name: 'Quillowbrand' });
        const chapterId = (await createChapter(f.ctx, other, { title: 'Far' })).id;
        const sceneId = (await createScene(f.ctx, other, { chapterId, title: 'Far scene' })).id;
        await saveSceneText(f.ctx, other, sceneId, { html: '<p>Quillowbrand sailed past the Zabrothen reef.</p>', baseRevision: 0 });
        const requests: Array<readonly AuthorDataBlock[]> = [];
        await readNight(f.ctx, { reader: draftReader('Mara', requests) });
        expect(requests).toHaveLength(2);
        const forKeeper = requests.find((r) => textOf(r, 'scene.text').includes('Mara'))!;
        expect(JSON.stringify(forKeeper)).not.toMatch(/Quillowbrand|Zabrothen/);
        const forOther = requests.find((r) => textOf(r, 'scene.text').includes('Quillowbrand'))!;
        expect(JSON.stringify(forOther)).not.toMatch(/Mara|Key to the lamp/);
    });

    it('spends from ONE nightly share with the continuity check: past it the reading waits NIGHTLY_CAP and sends nothing', async () => {
        const f = await fixture();
        await runWithoutRls({ reason: 'test' }, (db) =>
            db.aiCallLog.create({
                data: {
                    id: randomUUID(), workspaceId: f.ctx.workspaceId, bookId: f.bookId, purpose: 'continuity.deep-check', promptId: 'continuity.deep-check', promptVersion: 'continuity-deep.4.2.0',
                    tier: 'DEEP', model: 'claude-opus-5-5', attempts: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
                    costMicroUsd: BigInt(4_990_000), costEstimated: false, worstCaseMicroUsd: BigInt(750_000), durationMs: 1, outcome: 'OK',
                    guardRuleIds: [], guardReviewRequired: false, startedAt: new Date(),
                },
            }),
        );
        const requests: Array<readonly AuthorDataBlock[]> = [];
        expect(await readNight(f.ctx, { reader: draftReader('Mara', requests), nightlyCapMicroUsd: 5_000_000, worstCase: () => 20_000 })).toEqual(['NIGHTLY_CAP']);
        expect(requests).toHaveLength(0);
        // Another purpose's spend is not the share's: the same night with only a bible-extraction call goes on.
        const g = await fixture();
        await runWithoutRls({ reason: 'test' }, (db) =>
            db.aiCallLog.create({
                data: {
                    id: randomUUID(), workspaceId: g.ctx.workspaceId, bookId: g.bookId, purpose: 'facts.bible-extract', promptId: 'facts.bible-extract', promptVersion: 'x',
                    tier: 'FAST', model: 'claude-haiku', attempts: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
                    costMicroUsd: BigInt(4_990_000), costEstimated: false, worstCaseMicroUsd: BigInt(1), durationMs: 1, outcome: 'OK',
                    guardRuleIds: [], guardReviewRequired: false, startedAt: new Date(),
                },
            }),
        );
        expect(await readNight(g.ctx, { reader: draftReader('Mara', requests), nightlyCapMicroUsd: 5_000_000, worstCase: () => 20_000 })).toEqual(['OK']);
        expect(requests).toHaveLength(1);
    });
});

describe('the author’s three choices (D35 item 3)', () => {
    it('UPDATE THE BIBLE opens the field prefilled and writes nothing; the author’s save is one MANUSCRIPT version naming the scene', async () => {
        const f = await fixture();
        await readNight(f.ctx, { reader: draftReader('Mara', []) });
        const m = (await getContinuityPage(f.ctx, f.bookId)).draft.mismatches.items[0];
        const versionsBefore = await prisma.bibleEntryVersion.count({ where: { elementId: f.maraId } });
        const prefill = await getDraftUpdatePrefill(f.ctx, f.bookId, m.id);
        expect(prefill).toMatchObject({ elementId: f.maraId, fieldKey: 'physical_presence', prefillBasis: 'REPLACED', prefill: 'Mara has blue eyes and a slow way of walking.', sceneId: f.sceneId });
        // Opening the sheet saved nothing (rule 1).
        expect(await prisma.bibleEntryVersion.count({ where: { elementId: f.maraId } })).toBe(versionsBefore);
        // A save that changes nothing is refused, and decides nothing.
        await expect(updateBibleFromDraft(f.ctx, f.bookId, m.id, { baseVersion: prefill.baseVersion, value: prefill.current })).rejects.toMatchObject({ details: { reason: 'NOTHING_CHANGED' } });
        const saved = await updateBibleFromDraft(f.ctx, f.bookId, m.id, { baseVersion: prefill.baseVersion, value: 'Mara has blue eyes, grey at dusk, and a slow way of walking.' });
        expect(saved.status).toBe('BIBLE_UPDATED');
        const version = await prisma.bibleEntryVersion.findFirstOrThrow({ where: { elementId: f.maraId }, orderBy: { versionNumber: 'desc' }, select: { source: true, sourceSceneId: true, versionNumber: true } });
        expect(version).toEqual({ source: 'MANUSCRIPT', sourceSceneId: f.sceneId, versionNumber: saved.versionNumber });
        // Decided once: a second save is refused.
        await expect(updateBibleFromDraft(f.ctx, f.bookId, m.id, { baseVersion: saved.versionNumber, value: 'Mara has blue eyes.' })).rejects.toMatchObject({ details: { reason: 'PROPOSAL_DECIDED' } });
        // A stale base version is a conflict, as every bible save is.
        const g = await fixture();
        await readNight(g.ctx, { reader: draftReader('Mara', []) });
        const gm = (await getContinuityPage(g.ctx, g.bookId)).draft.mismatches.items[0];
        await expect(updateBibleFromDraft(g.ctx, g.bookId, gm.id, { baseVersion: 1, value: 'Mara has blue eyes.' })).rejects.toMatchObject({ details: { reason: 'VERSION_CONFLICT' } });
    });

    it('BOTH ARE TRUE needs an explanation and keeps it as an AUTHOR_RESOLUTION fact; FIX THE DRAFT settles FIXED once the scene no longer says it', async () => {
        const f = await fixture();
        await readNight(f.ctx, { reader: draftReader('Mara', []) });
        const m = (await getContinuityPage(f.ctx, f.bookId)).draft.mismatches.items[0];
        await expect(decideDraftMismatch(f.ctx, f.bookId, m.id, { decision: 'BOTH_TRUE' })).rejects.toMatchObject({ details: { reason: 'EXPLANATION_REQUIRED' } });
        const kept = await decideDraftMismatch(f.ctx, f.bookId, m.id, { decision: 'BOTH_TRUE', explanation: 'Her eyes change colour in lamplight.' });
        expect(kept.status).toBe('KEPT');
        const resolution = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findFirstOrThrow({ where: { id: kept.explanationFactId! }, select: { sourceKind: true, status: true } }));
        expect(resolution).toEqual({ sourceKind: 'AUTHOR_RESOLUTION', status: 'CONFIRMED' });

        const g = await fixture();
        await readNight(g.ctx, { reader: draftReader('Mara', []) });
        const gm = (await getContinuityPage(g.ctx, g.bookId)).draft.mismatches.items[0];
        expect((await decideDraftMismatch(g.ctx, g.bookId, gm.id, { decision: 'FIX_DRAFT' })).status).toBe('FIX_PENDING');
        // The author fixes the draft (their own typing): the next night re-reads it and the claim is gone.
        await saveSceneText(g.ctx, g.bookId, g.sceneId, { html: '<p>Mara looked up at the lamp, Mara’s green eyes wet. She promised to find the Key before the storm.</p>', baseRevision: g.revision });
        expect(await readNight(g.ctx, { reader: draftReader('Mara', []) })).toEqual(['OK']);
        const row = await runWithoutRls({ reason: 'test' }, (db) => db.storyFactProposal.findFirstOrThrow({ where: { id: gm.id }, select: { status: true, settledAt: true } }));
        expect(row.status).toBe('FIXED');
        expect(row.settledAt).not.toBeNull();
        expect((await getContinuityPage(g.ctx, g.bookId)).draft.mismatches.open).toBe(0);
    });

    it('a re-read that still finds the claim keeps ONE open mismatch, and a decided one is never raised again', async () => {
        const f = await fixture();
        await readNight(f.ctx, { reader: draftReader('Mara', []) });
        const m = (await getContinuityPage(f.ctx, f.bookId)).draft.mismatches.items[0];
        await decideDraftMismatch(f.ctx, f.bookId, m.id, { decision: 'BOTH_TRUE', explanation: 'Lamplight.' });
        // A change elsewhere in the scene: the claim stands, read again.
        await saveSceneText(f.ctx, f.bookId, f.sceneId, { html: '<p>Mara looked up at the high lamp, Mara’s blue eyes wet. She promised to find the Key before the storm.</p>', baseRevision: f.revision });
        await readNight(f.ctx, { reader: draftReader('Mara', []) });
        const rows = await runWithoutRls({ reason: 'test' }, (db) => db.storyFactProposal.findMany({ where: { bookId: f.bookId, basis: 'DRAFT' }, select: { status: true } }));
        expect(rows).toEqual([{ status: 'KEPT' }]);
    });
});

describe('plant and pay-off links (D35 item 4)', () => {
    it('a confirmed plant with no pay-off after it is an unpaid setup; a confirmed pay-off in a later scene settles it; a rejected link is never proposed again', async () => {
        const f = await fixture();
        await readNight(f.ctx, { reader: draftReader('Mara', []) });
        const link = (await getContinuityPage(f.ctx, f.bookId)).draft.linkProposals.items[0];
        expect((await decideThreadSceneLink(f.ctx, f.bookId, link.id, { decision: 'CONFIRM' })).status).toBe('CONFIRMED');
        await expect(decideThreadSceneLink(f.ctx, f.bookId, link.id, { decision: 'REJECT' })).rejects.toMatchObject({ details: { reason: 'LINK_DECIDED' } });
        let thread = (await getContinuityPage(f.ctx, f.bookId)).threads.items.find((t) => t.id === f.threadId)!;
        expect(thread).toMatchObject({ unpaidSetup: true, plantedIn: [{ sceneId: f.sceneId, sceneTitle: 'The lamp' }], paidIn: [] });

        const chapterId = (await prisma.manuscriptScene.findFirstOrThrow({ where: { id: f.sceneId }, select: { chapterId: true } })).chapterId;
        const later = (await createScene(f.ctx, f.bookId, { chapterId, title: 'The door' })).id;
        await saveSceneText(f.ctx, f.bookId, later, { html: '<p>At last she kept her word and turned the Key in the door.</p>', baseRevision: 0 });
        await readNight(f.ctx, { reader: draftReader('Mara', []) });
        const pays = (await getContinuityPage(f.ctx, f.bookId)).draft.linkProposals.items.find((l) => l.role === 'PAYS')!;
        await decideThreadSceneLink(f.ctx, f.bookId, pays.id, { decision: 'CONFIRM' });
        thread = (await getContinuityPage(f.ctx, f.bookId)).threads.items.find((t) => t.id === f.threadId)!;
        expect(thread).toMatchObject({ unpaidSetup: false, paidIn: [{ sceneId: later, sceneTitle: 'The door' }] });
        // Shown on the scene too (the editor's side panel).
        expect((await getSceneDraftNotes(f.ctx, f.bookId, later)).links).toEqual([expect.objectContaining({ role: 'PAYS', status: 'CONFIRMED' })]);
    });

    it('a rejected proposal is not proposed again for the same thread, scene and role', async () => {
        const f = await fixture();
        await readNight(f.ctx, { reader: draftReader('Mara', []) });
        const link = (await getContinuityPage(f.ctx, f.bookId)).draft.linkProposals.items[0];
        await decideThreadSceneLink(f.ctx, f.bookId, link.id, { decision: 'REJECT' });
        await saveSceneText(f.ctx, f.bookId, f.sceneId, { html: '<p>Mara’s blue eyes. Again she promised to find the Key.</p>', baseRevision: f.revision });
        await readNight(f.ctx, { reader: draftReader('Mara', []) });
        const links = await runWithoutRls({ reason: 'test' }, (db) => db.storyThreadSceneLink.findMany({ where: { bookId: f.bookId }, select: { status: true } }));
        expect(links).toEqual([{ status: 'REJECTED' }]);
    });
});

describe('deletion', () => {
    it('a deleted scene takes its draft facts, its mismatches, its links and its reading cursor with it', async () => {
        const f = await fixture();
        await readNight(f.ctx, { reader: draftReader('Mara', []) });
        await deleteScene(f.ctx, f.bookId, f.sceneId);
        const left = await runWithoutRls({ reason: 'test' }, async (db) => ({
            facts: await db.storyFact.count({ where: { bookId: f.bookId, sourceKind: 'SCENE_TEXT' } }),
            mismatches: await db.storyFactProposal.count({ where: { bookId: f.bookId, basis: 'DRAFT' } }),
            links: await db.storyThreadSceneLink.count({ where: { bookId: f.bookId } }),
            cursors: await db.sceneDraftRead.count({ where: { bookId: f.bookId } }),
        }));
        expect(left).toEqual({ facts: 0, mismatches: 0, links: 0, cursors: 0 });
        // The bible's own facts stand.
        expect(await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.count({ where: { bookId: f.bookId, sourceKind: 'BIBLE_VERSION', supersededAt: null } }))).toBe(1);
    });
});

describe('the scene card and "Grill me on this scene" (never the prose, D3)', () => {
    it('the author’s card save is versioned and refuses a stale version', async () => {
        const f = await fixture();
        expect(await getSceneCard(f.ctx, f.bookId, f.sceneId)).toMatchObject({ version: 0, goal: null, versions: [] });
        const saved = await saveSceneCard(f.ctx, f.bookId, f.sceneId, { baseVersion: 0, goal: 'Find the key.', conflict: null, outcome: null, change: null });
        expect(saved).toMatchObject({ version: 1, goal: 'Find the key.', versions: [{ versionNumber: 1, source: 'MANUAL' }] });
        await expect(saveSceneCard(f.ctx, f.bookId, f.sceneId, { baseVersion: 0, goal: 'Lose the key.', conflict: null, outcome: null, change: null })).rejects.toMatchObject({ details: { reason: 'VERSION_CONFLICT' } });
        // Nothing changed: no version.
        expect((await saveSceneCard(f.ctx, f.bookId, f.sceneId, { baseVersion: 1, goal: 'Find the key.', conflict: null, outcome: null, change: null })).version).toBe(1);
    });

    it('a scene interview asks about the card, and only an accepted proposal writes the card — one INTERVIEW version naming the answer; the scene’s text is untouched', async () => {
        const f = await fixture();
        await runWithoutRls({ reason: 'test' }, (db) => db.manuscriptScene.update({ where: { id: f.sceneId }, data: { povElementId: f.maraId } }));
        const textBefore = await prisma.manuscriptScene.findFirstOrThrow({ where: { id: f.sceneId }, select: { text: true, revision: true } });
        const view = await startInterview(f.ctx, f.bookId, { scope: 'SCENE', sceneId: f.sceneId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder });
        expect(view.session.scope).toBe('SCENE');
        const subject = sceneSubjectId(f.sceneId);
        const questions = view.round!.questions;
        expect(questions.length).toBeGreaterThan(0);
        expect(questions.every((q) => q.subjectId === subject)).toBe(true);
        const goalQ = questions.find((q) => q.targetsFieldKeys.includes('goal'))!;
        expect(goalQ).toBeDefined();
        await answerQuestion(f.ctx, f.bookId, view.session.id, goalQ.id, { text: 'She wants the key to the lamp room before the storm.' });
        const answerId = (await runWithoutRls({ reason: 'test' }, (db) => db.answer.findFirstOrThrow({ where: { questionId: goalQ.id }, select: { id: true } }))).id;
        const reconciler = scripted((facts) => ({
            operations: facts.elements
                .filter((e) => e.elementId === subject)
                .map((e) => ({ elementId: e.elementId, fieldKey: 'goal', op: 'ADD', value: 'She wants the key to the lamp room before the storm.', cites: [answerId] })),
            newElements: [],
            newRelations: [],
        }));
        await closeRoundAndReconcile(f.ctx, f.bookId, view.session.id, String(view.round!.number), { skipUnanswered: true }, { reconciler, gate: async () => ({ mounted: true, recordKind: 'structural' }) });
        const review = await getSessionReview(f.ctx, f.bookId, view.session.id);
        expect(review.sceneCardFields).toEqual([expect.objectContaining({ sceneId: f.sceneId, fieldKey: 'goal', operation: 'ADD', currentValue: null, baseVersion: 0 })]);
        // Proposed, not written (rule 1).
        expect((await getSceneCard(f.ctx, f.bookId, f.sceneId)).goal).toBeNull();
        // HOLD FOLLOW-UPS (D30) hold a card field too: another scene session does not ask about the goal while its proposal waits.
        const second = await startInterview(f.ctx, f.bookId, { scope: 'SCENE', sceneId: f.sceneId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder });
        expect(second.round?.questions.some((q) => q.targetsFieldKeys.includes('goal')) ?? false).toBe(false);
        expect(second.round?.questions.some((q) => q.targetsFieldKeys.includes('change')) ?? false).toBe(true);
        const p = review.sceneCardFields[0];
        await acceptProposal(f.ctx, f.bookId, view.session.id, p.id, { baseVersion: 0 });
        const card = await getSceneCard(f.ctx, f.bookId, f.sceneId);
        expect(card).toMatchObject({ goal: 'She wants the key to the lamp room before the storm.', version: 1, versions: [{ versionNumber: 1, source: 'INTERVIEW' }] });
        const version = await runWithoutRls({ reason: 'test' }, (db) => db.sceneCardVersion.findFirstOrThrow({ where: { sceneId: f.sceneId }, select: { sourceAnswerIds: true } }));
        expect(version.sourceAnswerIds).toEqual([answerId]);
        // D3: the scene's prose and revision are exactly as they were.
        expect(await prisma.manuscriptScene.findFirstOrThrow({ where: { id: f.sceneId }, select: { text: true, revision: true } })).toEqual(textBefore);
        expect((await getInterview(f.ctx, f.bookId, view.session.id)).session.sceneId).toBe(f.sceneId);
    });

    it('a scene with no point of view, setting, beat or linked entry cannot be grilled yet (409 SCENE_HAS_NO_ELEMENT)', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Bare' })).id;
        const chapterId = (await createChapter(ctx, bookId, { title: 'One' })).id;
        const sceneId = (await createScene(ctx, bookId, { chapterId, title: 'Empty' })).id;
        await expect(startInterview(ctx, bookId, { scope: 'SCENE', sceneId, depth: 2, detail: 3 }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder })).rejects.toMatchObject({ details: { reason: 'SCENE_HAS_NO_ELEMENT' } });
    });
});
