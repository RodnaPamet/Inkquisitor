/**
 * THE OWNER'S THREE DECISIONS OF 2026-11-27 ON 5.3 (D35 addendum), end to end against the real database, with scripted
 * readers and checkers — no model, no network:
 *
 *   A  the nightly deep check reads the book's DRAFT facts only when the author turned that on (a per-book setting, off
 *      by default): off, it reads, sends and raises exactly what it did before; on, the draft facts travel in their own
 *      "draft-facts" block and a draft-vs-bible pair is raised as a draft mismatch (basis DRAFT, naming the continuity
 *      run), never a pair of two draft facts; a deep-found mismatch is not settled by the rules' silence;
 *   B  the night's share is split in halves: each purpose takes at most half while the other still has work that night,
 *      the whole share once the other has none, enforced by the ledger under its spend lock;
 *   C  mismatches that settled by themselves are listed as "Recently resolved" for 30 days by the database's clock,
 *      bounded, with how they settled.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene } from '@/app-layer/usecases/manuscript';
import { saveSceneText, updateSceneMeta } from '@/app-layer/usecases/manuscript-scenes';
import { getContinuityPage, getContinuitySettings, saveContinuitySettings } from '@/app-layer/usecases/continuity';
import { executeContinuityDispatch } from '@/app-layer/usecases/continuity-dispatch';
import { executeContinuityCheck, type ContinuityCheckDeps } from '@/app-layer/usecases/continuity-check';
import { executeDraftReadDispatch } from '@/app-layer/usecases/draft-read-dispatch';
import { executeDraftRead, type DraftReadDeps } from '@/app-layer/usecases/draft-read';
import { workspaceAiLedger } from '@/app-layer/usecases/model-calls';
import { nightShareFor } from '@/app-layer/usecases/night-share';
import { CONTINUITY_PASS_SETTLE_MS } from '@/lib/continuity/vocabulary';
import type { ContinuityChecker } from '@/lib/continuity/model-seam';
import { RECENTLY_RESOLVED_MAX } from '@/lib/draft-facts/vocabulary';
import { DRAFT_READ_PURPOSE } from '@/lib/draft-facts/prompt';
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import type { FactExtractor } from '@/lib/sources/extractor';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { extractPending } from '../helpers/facts';
import { nextTestNight } from '../helpers/continuity';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const MOUNTED = () => ({ mounted: true as const, recordKind: 'structural' as const });
const textOf = (blocks: readonly AuthorDataBlock[], label: string) => blocks.find((b) => b.label === label)?.text ?? '';

/** A scripted bible fact extractor: "<Name> keeps the light." in an entry is a ROLE fact (no rule compares two ROLEs). */
function roleExtractor(name: string): () => FactExtractor {
    return () => ({
        async extract(request) {
            const text = textOf(request.data, 'entry.text');
            const facts = text.includes(`${name} keeps the light`) ? [{ subject: name, predicate: 'ROLE', object: 'keeps the light', statement: `${name} keeps the light.`, quote: `${name} keeps the light`, storyTimeFrom: '', storyTimeTo: '', contradicts: [] }] : [];
            return { ok: true, output: { facts }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
        },
    });
}

/** A scripted draft reader: every sentence "<Name> <rest>." about the name is a ROLE fact of the scene. */
function roleReader(name: string, requests: Array<readonly AuthorDataBlock[]> = []): NonNullable<DraftReadDeps['reader']> {
    return () => ({
        async extract(request) {
            requests.push(request.data);
            const text = textOf(request.data, 'scene.text');
            const facts = [...text.matchAll(new RegExp(`${name} [^.]+\\.`, 'g'))].map((m) => ({ subject: name, predicate: 'ROLE', object: '', statement: m[0], quote: m[0].slice(0, -1), storyTimeFrom: '', storyTimeTo: '' }));
            return { ok: true, output: { facts, threads: [] }, tokensUsed: 1, costMicroUsd: 10, callIds: [] };
        },
    });
}

/** The draft reading's night `nightKey`: dispatch, then each run. */
async function readNight(ctx: WorkspaceRequestContext, deps: DraftReadDeps, nightKey = nextTestNight()): Promise<Array<string | null>> {
    const queued: string[] = [];
    await executeDraftReadDispatch({ enqueue: async (_n, payload) => void queued.push((payload as { runId: string }).runId), workspaceIds: [ctx.workspaceId], nightKey });
    const undo = setFakeApiKey();
    try {
        const out: Array<string | null> = [];
        for (const runId of queued) out.push((await executeDraftRead({ workspaceId: ctx.workspaceId, runId }, { charge: () => undefined, gate: MOUNTED, nightlyCapMicroUsd: 1_000_000_000, ...deps })).outcome);
        return out;
    } finally {
        undo();
    }
}

/** The continuity check's night `nightKey`: dispatch, then each run (a settle margin after the facts just written). */
async function checkNight(ctx: WorkspaceRequestContext, deps: ContinuityCheckDeps, nightKey = nextTestNight()): Promise<Array<{ outcome: string | null; runId: string }>> {
    const queued: string[] = [];
    await executeContinuityDispatch({ enqueue: async (_n, payload) => void queued.push((payload as { runId: string }).runId), workspaceIds: [ctx.workspaceId], nightKey });
    const undo = setFakeApiKey();
    try {
        const out: Array<{ outcome: string | null; runId: string }> = [];
        for (const runId of queued) {
            const r = await executeContinuityCheck({ workspaceId: ctx.workspaceId, runId }, { charge: () => undefined, gate: MOUNTED, now: () => new Date(Date.now() + CONTINUITY_PASS_SETTLE_MS), nightlyCapMicroUsd: 1_000_000_000, ...deps });
            out.push({ outcome: r.outcome, runId });
        }
        return out;
    } finally {
        undo();
    }
}

/** A checker that records each request and answers with the pairs `answer` picks from the shown lines. */
function recordingChecker(requests: Array<readonly AuthorDataBlock[]>, answer: (facts: string[], draft: string[]) => Array<{ first: number; second: number; kind: string }> = () => []): ContinuityCheckDeps['checker'] {
    return (): ContinuityChecker => ({
        async extract(request) {
            requests.push(request.data);
            const lines = (label: string) => textOf(request.data, label).split('\n').filter((l) => l.trim() !== '');
            return { ok: true, output: { contradictions: answer(lines('facts'), lines('draft-facts')) }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
        },
    });
}

/** A line's number in the call ("12. [ROLE] …" → 12). */
const numberOf = (line: string) => Number(/^(\d+)\./.exec(line)?.[1] ?? 0);

interface Fixture {
    ctx: WorkspaceRequestContext;
    bookId: string;
    chapterId: string;
    sceneId: string;
    otherSceneId: string;
}

/** A book whose bible says Mara keeps the light, and two scenes that each say something else about her. */
async function fixture(): Promise<Fixture> {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title: 'The keeper' })).id;
    await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara', summary: 'Mara keeps the light.' });
    await extractPending(ctx, bookId, roleExtractor('Mara'));
    const chapterId = (await createChapter(ctx, bookId, { title: 'One' })).id;
    const sceneId = (await createScene(ctx, bookId, { chapterId, title: 'The lamp' })).id;
    await saveSceneText(ctx, bookId, sceneId, { html: '<p>Mara has never climbed the lighthouse stair.</p>', baseRevision: 0 });
    const otherSceneId = (await createScene(ctx, bookId, { chapterId, title: 'The harbour' })).id;
    await saveSceneText(ctx, bookId, otherSceneId, { html: '<p>Mara mends nets on the harbour wall every night.</p>', baseRevision: 0 });
    return { ctx, bookId, chapterId, sceneId, otherSceneId };
}

const deepMismatches = (bookId: string) =>
    runWithoutRls({ reason: 'test' }, (db) => db.storyFactProposal.findMany({ where: { bookId, basis: 'DRAFT', checkRunId: { not: null } }, select: { id: true, status: true, sceneId: true, checkRunId: true, draftRunId: true, settleReason: true } }));

describe('A — the deep check reads the draft only when the author asks (a per-book setting, off by default)', () => {
    it('off: draft facts are neither read, shown nor a reason to check the book again; on: they travel labelled as the draft and a draft-vs-bible pair is raised, never a pair of two draft facts', async () => {
        const f = await fixture();
        const quietRequests: Array<readonly AuthorDataBlock[]> = [];
        // The bible's own pass, before the draft is read.
        expect((await checkNight(f.ctx, { checker: recordingChecker(quietRequests) })).map((r) => r.outcome)).toEqual(['OK']);
        expect(await readNight(f.ctx, { reader: roleReader('Mara') })).toEqual(['OK']);
        expect(await getContinuitySettings(f.ctx, f.bookId)).toEqual({ deepReadsDraft: false });

        // OFF (the default): new draft facts do not make the book due, and a pass over a changed bible shows none.
        expect(await checkNight(f.ctx, { checker: recordingChecker(quietRequests) })).toEqual([]);
        await createElement(f.ctx, f.bookId, { kind: 'CHARACTER', name: 'Ostrik', summary: 'Ostrik keeps the light.' });
        await extractPending(f.ctx, f.bookId, roleExtractor('Ostrik'));
        const offRequests: Array<readonly AuthorDataBlock[]> = [];
        expect((await checkNight(f.ctx, { checker: recordingChecker(offRequests) })).map((r) => r.outcome)).toEqual(['OK']);
        expect(offRequests.length).toBeGreaterThan(0);
        for (const r of offRequests) {
            expect(r.map((b) => b.label)).toEqual(['facts']);
            expect(textOf(r, 'facts')).not.toMatch(/lighthouse stair|harbour wall/);
        }
        expect(await deepMismatches(f.bookId)).toEqual([]);

        // ON: the next night's pass shows Mara's draft facts in their own block, numbered on, each naming its scene.
        await saveContinuitySettings(f.ctx, f.bookId, { deepReadsDraft: true });
        const onRequests: Array<readonly AuthorDataBlock[]> = [];
        const ran = await checkNight(f.ctx, {
            checker: recordingChecker(onRequests, (facts, draft) => {
                const bible = facts.find((l) => l.includes('Mara keeps the light'));
                const stair = draft.find((l) => l.includes('lighthouse stair'));
                const nets = draft.find((l) => l.includes('harbour wall'));
                // The bible against the draft (raised), and the two draft facts against each other (refused).
                return bible && stair && nets ? [{ first: numberOf(bible), second: numberOf(stair), kind: 'OTHER' }, { first: numberOf(stair), second: numberOf(nets), kind: 'OTHER' }] : [];
            }),
        });
        expect(ran.map((r) => r.outcome)).toEqual(['OK']);
        const shown = onRequests.find((r) => textOf(r, 'draft-facts') !== '')!;
        expect(shown.map((b) => b.label)).toEqual(['facts', 'draft-facts']);
        expect(textOf(shown, 'draft-facts')).toMatch(/^[23]\. \[ROLE\] Mara: Mara has never climbed the lighthouse stair\. \(scene: The lamp\)$/m);
        expect(textOf(shown, 'draft-facts')).toMatch(/\(scene: The harbour\)$/m);
        const raised = await deepMismatches(f.bookId);
        expect(raised).toEqual([{ id: expect.any(String), status: 'PENDING', sceneId: f.sceneId, checkRunId: ran[0].runId, draftRunId: null, settleReason: null }]);
        const run = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.findUniqueOrThrow({ where: { id: ran[0].runId }, select: { metrics: true, deepProposals: true } }));
        expect(run.metrics).toMatchObject({ draftFactsRead: 2, deepDraftMismatches: 1, refusals: { DRAFT_PAIR: 1 } });
        expect(run.deepProposals).toBe(0);
        const page = await getContinuityPage(f.ctx, f.bookId);
        expect(page.settings).toEqual({ deepReadsDraft: true });
        expect(page.draft.mismatches.items.map((m) => [m.sceneId, m.foundBy])).toEqual([[f.sceneId, 'DEEP_CHECK']]);

        // The rules never find that pair, and their silence settles nothing: a details-only save re-compares it and it stays.
        const scene = await runWithoutRls({ reason: 'test' }, (db) => db.manuscriptScene.findUniqueOrThrow({ where: { id: f.sceneId }, select: { revision: true } }));
        await updateSceneMeta(f.ctx, f.bookId, f.sceneId, { baseRevision: scene.revision, storyTime: 'The first night' });
        expect(await readNight(f.ctx, { reader: roleReader('Mara') })).toEqual(['OK']);
        expect((await deepMismatches(f.bookId)).map((m) => m.status)).toEqual(['PENDING']);

        // The scene stops making the claim: the next read settles it FIXED, and it moves to "Recently resolved".
        const now = await runWithoutRls({ reason: 'test' }, (db) => db.manuscriptScene.findUniqueOrThrow({ where: { id: f.sceneId }, select: { revision: true } }));
        await saveSceneText(f.ctx, f.bookId, f.sceneId, { html: '<p>The stair was dark that night.</p>', baseRevision: now.revision });
        expect(await readNight(f.ctx, { reader: roleReader('Mara') })).toEqual(['OK']);
        expect((await deepMismatches(f.bookId)).map((m) => [m.status, m.settleReason])).toEqual([['FIXED', 'DRAFT_CHANGED']]);
        const after = await getContinuityPage(f.ctx, f.bookId);
        expect(after.draft.mismatches.items).toEqual([]);
        expect(after.draft.recentlyResolved.items.map((m) => [m.sceneId, m.status, m.settled?.reason, m.foundBy])).toEqual([[f.sceneId, 'FIXED', 'DRAFT_CHANGED', 'DEEP_CHECK']]);
    });

    it('the setting is the author’s: a reader reads it and cannot change it, and a change is audited with ids and the value only', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        const bookId = (await createBook(ctx, { title: 'Settings' })).id;
        const reader = await createBareUser();
        await addMember(owner.workspaceId, reader.id, 'READER');
        const readerCtx = workspaceCtx({ ...owner, userId: reader.id }, 'READER');
        expect(await getContinuitySettings(readerCtx, bookId)).toEqual({ deepReadsDraft: false });
        await expect(saveContinuitySettings(readerCtx, bookId, { deepReadsDraft: true })).rejects.toMatchObject({ status: 403 });
        await expect(saveContinuitySettings(ctx, bookId, { deepReadsDraft: 'yes' })).rejects.toMatchObject({ status: 400 });
        expect(await saveContinuitySettings(ctx, bookId, { deepReadsDraft: true })).toEqual({ deepReadsDraft: true });
        expect(await saveContinuitySettings(ctx, bookId, { deepReadsDraft: true })).toEqual({ deepReadsDraft: true });
        expect(await getContinuitySettings(readerCtx, bookId)).toEqual({ deepReadsDraft: true });
        const audit = await runWithoutRls({ reason: 'test' }, (db) => db.auditLog.findMany({ where: { workspaceId: owner.workspaceId, action: 'CONTINUITY_SETTINGS_SAVED' }, select: { detailsJson: true } }));
        // Once: the second save changed nothing.
        expect(audit).toEqual([{ detailsJson: { bookId, deepReadsDraft: true } }]);
    });
});

/** A spend of `purpose` charged just now in the workspace (the night's window counts it). */
async function spent(ctx: WorkspaceRequestContext, bookId: string, purpose: string, costMicroUsd: number): Promise<void> {
    await runWithoutRls({ reason: 'test' }, (db) =>
        db.aiCallLog.create({
            data: {
                id: randomUUID(), workspaceId: ctx.workspaceId, bookId, purpose, promptId: purpose, promptVersion: 'x',
                tier: 'FAST', model: 'claude-haiku', attempts: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
                costMicroUsd: BigInt(costMicroUsd), costEstimated: false, worstCaseMicroUsd: BigInt(1), durationMs: 1, outcome: 'OK',
                guardRuleIds: [], guardReviewRequired: false, startedAt: new Date(),
            },
        }),
    );
}

const CAP = 5_000_000;

describe('B — each purpose takes at most half the night’s share while the other still has work', () => {
    it('the draft reading stops at its half while a continuity run of the night is queued, and takes the rest once the check has finished', async () => {
        const f = await fixture();
        await spent(f.ctx, f.bookId, DRAFT_READ_PURPOSE, 2_490_000);
        const busy = nextTestNight();
        await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.create({ data: { workspaceId: f.ctx.workspaceId, bookId: f.bookId, status: 'QUEUED', nightKey: busy } }));
        const requests: Array<readonly AuthorDataBlock[]> = [];
        expect(await readNight(f.ctx, { reader: roleReader('Mara', requests), nightlyCapMicroUsd: CAP, worstCase: () => 20_000 }, busy)).toEqual(['NIGHTLY_CAP']);
        expect(requests).toHaveLength(0);
        const stopped = await runWithoutRls({ reason: 'test' }, (db) => db.draftReadRun.findFirstOrThrow({ where: { bookId: f.bookId, nightKey: busy }, select: { metrics: true } }));
        expect(stopped.metrics).toMatchObject({ shareStop: 'HALF' });

        // Another night whose check has finished: the reading may spend past its half (the share's total still binds).
        const done = nextTestNight();
        await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.create({ data: { workspaceId: f.ctx.workspaceId, bookId: f.bookId, status: 'DONE', outcome: 'OK', nightKey: done, finishedAt: new Date() } }));
        expect(await readNight(f.ctx, { reader: roleReader('Mara', requests), nightlyCapMicroUsd: CAP, worstCase: () => 20_000 }, done)).toEqual(['OK']);
        expect(requests.length).toBeGreaterThan(0);
    });

    it('the continuity check stops at its half while the draft reading still has scenes to read tonight, and takes the rest once the reading is done', async () => {
        const f = await fixture();
        await spent(f.ctx, f.bookId, 'continuity.deep-check', 2_490_000);
        const requests: Array<readonly AuthorDataBlock[]> = [];
        // The reading has not been dispatched tonight and two scenes wait: it has work, so the check is held to its half.
        const busy = await checkNight(f.ctx, { checker: recordingChecker(requests), nightlyCapMicroUsd: CAP, worstCase: () => 20_000 }, nextTestNight());
        expect(busy.map((r) => r.outcome)).toEqual(['NIGHTLY_CAP']);
        expect(requests).toHaveLength(0);
        const run = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.findUniqueOrThrow({ where: { id: busy[0].runId }, select: { metrics: true } }));
        expect(run.metrics).toMatchObject({ shareStop: 'HALF' });

        // A night whose reading is done in this workspace: the check may spend past its half.
        const done = nextTestNight();
        await runWithoutRls({ reason: 'test' }, (db) => db.draftReadRun.create({ data: { workspaceId: f.ctx.workspaceId, bookId: f.bookId, nightKey: done, status: 'DONE', outcome: 'OK', finishedAt: new Date() } }));
        expect((await checkNight(f.ctx, { checker: recordingChecker(requests), nightlyCapMicroUsd: CAP, worstCase: () => 20_000 }, done)).map((r) => r.outcome)).toEqual(['OK']);
        expect(requests.length).toBeGreaterThan(0);
    });

    it('under the ledger’s spend lock, concurrent calls of one purpose never pass its half together while the other has work, and pass it (within the share) once it has none', async () => {
        const f = await fixture();
        const night = nextTestNight();
        const draftRun = await runWithoutRls({ reason: 'test' }, (db) => db.draftReadRun.create({ data: { workspaceId: f.ctx.workspaceId, bookId: f.bookId, nightKey: night, status: 'RUNNING' }, select: { id: true } }));
        const share = nightShareFor(f.ctx, 'continuity', { claim: new Date(), nightKey: night, capMicroUsd: 1_000_000 });
        const ledger = workspaceAiLedger(f.ctx, share);
        const reserve = () => ledger.reserve({ callId: `c-${randomUUID()}`, purpose: 'continuity.deep-check', amountMicroUsd: 300_000, ceilingMicroUsd: 1_000_000_000, ttlMs: 60_000, startedAt: new Date() });
        // Half is 500,000: of three concurrent 300,000 reservations, one fits while the reading runs.
        const busy = await Promise.all([reserve(), reserve(), reserve()]);
        expect(busy.filter((r) => r.ok)).toHaveLength(1);
        expect(busy.filter((r) => !r.ok).every((r) => !r.ok && r.limit === 'NIGHTLY_SHARE')).toBe(true);
        // The reading finishes: the check may take the share's rest (two more fit in 1,000,000; never a fourth).
        await runWithoutRls({ reason: 'test' }, (db) => db.draftReadRun.update({ where: { id: draftRun.id }, data: { status: 'DONE', outcome: 'OK', finishedAt: new Date() } }));
        const idle = await Promise.all([reserve(), reserve(), reserve()]);
        expect(idle.filter((r) => r.ok)).toHaveLength(2);
        // The other purpose is still held to the share's total.
        const draftShare = nightShareFor(f.ctx, 'draft', { claim: new Date(), nightKey: night, capMicroUsd: 1_000_000 });
        const draft = await workspaceAiLedger(f.ctx, draftShare).reserve({ callId: `d-${randomUUID()}`, purpose: DRAFT_READ_PURPOSE, amountMicroUsd: 200_000, ceilingMicroUsd: 1_000_000_000, ttlMs: 60_000, startedAt: new Date() });
        expect(draft.ok).toBe(false);
    });
});

describe('C — "Recently resolved": draft mismatches that settled by themselves, for 30 days by the database’s clock', () => {
    it('a mismatch whose bible fact went is listed with how it settled; one settled 31 days ago (the database’s clock) is not; the list is bounded and names its cut', async () => {
        const { seedDraftMismatch } = await import('../helpers/manuscript');
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Eyes' })).id;
        const chapterId = (await createChapter(ctx, bookId, { title: 'One' })).id;
        const { mismatchId, sceneId } = await seedDraftMismatch(ctx, bookId, chapterId);
        // Rule 6: nothing settled yet is all the empty list says; the open mismatch is still listed above it.
        const before = await getContinuityPage(ctx, bookId);
        expect(before.draft.recentlyResolved).toEqual({ items: [], days: 30, truncated: false });
        expect(before.draft.mismatches.items.map((m) => m.id)).toEqual([mismatchId]);

        // The bible fact goes (a retracted entry's facts are superseded with no decision on this mismatch); the scene's
        // next read settles the mismatch by itself: INVALIDATED, when and how recorded.
        await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.updateMany({ where: { bookId, sourceKind: 'BIBLE_VERSION' }, data: { supersededAt: new Date() } }));
        const rev = await runWithoutRls({ reason: 'test' }, (db) => db.manuscriptScene.findUniqueOrThrow({ where: { id: sceneId }, select: { revision: true } }));
        await updateSceneMeta(ctx, bookId, sceneId, { baseRevision: rev.revision, storyTime: 'Dusk' });
        expect(await readNight(ctx, { reader: () => ({ extract: async () => ({ ok: true, output: { facts: [], threads: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] }) }) })).toEqual(['OK']);
        const settled = await runWithoutRls({ reason: 'test' }, (db) => db.storyFactProposal.findUniqueOrThrow({ where: { id: mismatchId }, select: { status: true, settleReason: true, settledAt: true } }));
        expect(settled).toEqual({ status: 'INVALIDATED', settleReason: 'BIBLE_GONE', settledAt: expect.any(Date) });
        const page = await getContinuityPage(ctx, bookId);
        expect(page.draft.mismatches.items).toEqual([]);
        expect(page.draft.recentlyResolved.items.map((m) => [m.id, m.sceneId, m.bible.elementName, m.settled?.reason])).toEqual([[mismatchId, sceneId, 'Mara', 'BIBLE_GONE']]);

        // Copies of it settled 29 and 31 days ago by the database's clock: only the first is still shown.
        const copy = (ago: string) =>
            runWithoutRls({ reason: 'test' }, (db) =>
                db.$executeRawUnsafe(
                    `INSERT INTO "StoryFactProposal" ("id", "workspaceId", "bookId", "factId", "newerFactId", "reason", "basis", "status", "kind", "sceneId", "draftClaimKey", "draftRunId", "settledAt", "settleReason", "decidedAt", "createdAt")
                     SELECT gen_random_uuid()::text, "workspaceId", "bookId", "factId", "newerFactId", "reason", "basis", 'FIXED', "kind", "sceneId", "draftClaimKey", "draftRunId", now() - $2::interval, 'DRAFT_CHANGED', now() - $2::interval, "createdAt"
                     FROM "StoryFactProposal" WHERE "id" = $1`,
                    mismatchId,
                    ago,
                ),
            );
        await copy('29 days');
        await copy('31 days');
        const windowed = await getContinuityPage(ctx, bookId);
        expect(windowed.draft.recentlyResolved.items.map((m) => m.settled?.reason)).toEqual(['BIBLE_GONE', 'DRAFT_CHANGED']);
        expect(windowed.draft.recentlyResolved.truncated).toBe(false);

        // Bounded: past `RECENTLY_RESOLVED_MAX` the newest are shown and the cut is named.
        for (let i = 0; i < RECENTLY_RESOLVED_MAX; i++) await copy(`${i + 1} minutes`);
        const cut = await getContinuityPage(ctx, bookId);
        expect(cut.draft.recentlyResolved.items).toHaveLength(RECENTLY_RESOLVED_MAX);
        expect(cut.draft.recentlyResolved.truncated).toBe(true);
    });

    it('the database holds how a mismatch settled: a settlement carries its reason, and neither moves once written', async () => {
        const { seedDraftMismatch } = await import('../helpers/manuscript');
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Held' })).id;
        const chapterId = (await createChapter(ctx, bookId, { title: 'One' })).id;
        const { mismatchId } = await seedDraftMismatch(ctx, bookId, chapterId);
        const write = (data: Record<string, unknown>) => runInWorkspaceContext(ctx, (db) => db.storyFactProposal.update({ where: { id: mismatchId }, data }));
        // A settlement with no reason, or a reason the CHECK does not know, is refused.
        await expect(write({ status: 'FIXED', decidedAt: new Date(), settledAt: new Date() })).rejects.toThrow();
        await expect(write({ status: 'FIXED', decidedAt: new Date(), settledAt: new Date(), settleReason: 'TIRED' })).rejects.toThrow();
        // INVALIDATED is only ever the bible going.
        await expect(write({ status: 'INVALIDATED', decidedAt: new Date(), settledAt: new Date(), settleReason: 'DRAFT_CHANGED' })).rejects.toThrow();
        await write({ status: 'FIXED', decidedAt: new Date(), settledAt: new Date(), settleReason: 'DRAFT_CHANGED' });
        await expect(write({ settleReason: 'BIBLE_GONE' })).rejects.toThrow(/STORY_FACT_PROPOSAL_FIXED/);
    });
});
