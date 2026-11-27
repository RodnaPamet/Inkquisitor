/**
 * The prose checks (Phase 5.2, D34), against a real PostgreSQL and Redis:
 *
 *   - the debounce THROUGH BullMQ: two saves while the scene's check waits are
 *     one check, and a save while it runs is kept and checked after it
 *   - end to end: a save queues the check, the real worker runs it, the margin
 *     reads it CHECKED with each note's text
 *   - a newer save supersedes a running check (no stale finding is stored)
 *   - a dismissal survives an unchanged sentence and is re-raised when it changes;
 *     a rule turned off hides its notes; the inclusive-language check, turned on,
 *     never reads speech
 *   - nothing in clear: a finding's detail and the baseline are envelopes; a
 *     dismissal is a keyed hash; another workspace reads none of it
 *   - zero is never complete: a scene never checked reads NOT_CHECKED
 */
import { Client } from 'pg';
import type { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { testRedisUrl } from '../helpers/test-redis';

process.env.REDIS_URL = testRedisUrl();
const queueName = `inkquisitor-prose-test-${process.pid}-${Date.now()}`;

import { Queue, Worker as BullWorker, type ConnectionOptions } from 'bullmq';
import { prisma, workspaceKeys } from '@/lib/db';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { closeQueue, enqueue, getQueue } from '@/app-layer/jobs/queue';
import { createJobWorker } from '@/app-layer/jobs/worker';
import { createProcessLogger } from '@/lib/observability/process-logger';
import { closeRedisClient, createRedisClient } from '@/lib/redis';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene, deleteScene } from '@/app-layer/usecases/manuscript';
import { saveSceneText } from '@/app-layer/usecases/manuscript-scenes';
import { executeProseCheck } from '@/app-layer/usecases/prose-check-run';
import { scheduleProseCheck, type EnqueueProseCheck } from '@/app-layer/usecases/prose-check-schedule';
import { clearProseDismissals, dismissProseFinding, getProseCheckSettings, getSceneProseChecks, requestSceneProseCheck, rerunChapterProseChecks, saveProseCheckSettings } from '@/app-layer/usecases/prose-checks';
import { NotFoundError } from '@/lib/errors/types';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

const log = createProcessLogger('worker');
let ctx: ReturnType<typeof workspaceCtx>;
let bookId: string;
let connection: Redis;

/** Enqueue a scene's check on this suite's own queue, with the scheduler's options (and, for speed, a shorter delay). */
const toTestQueue =
    (delay?: number, name = queueName): EnqueueProseCheck =>
    (payload, opts) =>
        enqueue('prose-check', payload, { ...opts, ...(delay !== undefined ? { delay } : {}), queueName: name });

/** Wait, bounded, until `probe` answers truthy (a condition, never a clock verdict). */
async function until<T>(probe: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v) return v;
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 50));
    }
}

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount());
    bookId = (await createBook(ctx, { title: 'Prose book' })).id;
    connection = createRedisClient(testRedisUrl(), 'inkquisitor-prose-test');
});

afterAll(async () => {
    await closeQueue();
    await closeRedisClient(connection);
    await prisma.$disconnect();
});

async function newScene(html: string, title = 'A scene') {
    const chapter = await createChapter(ctx, bookId, { title: `Chapter for ${title}` });
    const scene = await createScene(ctx, bookId, { chapterId: chapter.id, title });
    const saved = await saveSceneText(ctx, bookId, scene.id, { html, baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
    return { chapterId: chapter.id, sceneId: scene.id, revision: saved.revision };
}

async function styleSheet(fields: Array<{ key: string; value: unknown }>) {
    const style = await createElement(ctx, bookId, { kind: 'STYLE', name: `Sheet ${Math.random().toString(36).slice(2, 7)}`, fields: [{ key: 'style_scope', value: 'whole_book' }] });
    await updateElementFields(ctx, bookId, style.id, { fields, baseVersion: style.versionNumber });
    return style.id;
}

describe('the debounce, through BullMQ', () => {
    it('two saves while a scene’s check waits are ONE check, moved to after the newer save', async () => {
        const q = getQueue(queueName);
        // Through the scheduler itself (its deduplication options), onto this suite's queue.
        const schedule = () => scheduleProseCheck(ctx.workspaceId, 'debounce-a', { enqueue: toTestQueue(60_000) });
        expect(await schedule()).toBe('SCHEDULED');
        const first = (await q.getDelayed()).filter((j) => j.data.sceneId === 'debounce-a');
        expect(first).toHaveLength(1);
        const firstDue = Number(await connection.zscore(`bull:${queueName}:delayed`, first[0].id!));
        await new Promise((r) => setTimeout(r, 20));
        expect(await schedule()).toBe('SCHEDULED');
        const jobs = (await q.getDelayed()).filter((j) => j.data.sceneId === 'debounce-a');
        expect(jobs).toHaveLength(1);
        // Rescheduled: due later than it was (the delayed set's score holds the due time).
        expect(Number(await connection.zscore(`bull:${queueName}:delayed`, jobs[0].id!))).toBeGreaterThan(firstDue);
        await q.obliterate({ force: true });
    });

    it('a save while the check RUNS is kept, and checked once it finishes', async () => {
        const name = `${queueName}-active`;
        const runs: string[] = [];
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        const workerConnection = createRedisClient(testRedisUrl(), 'inkquisitor-prose-test-worker');
        const worker = new BullWorker(
            name,
            async (job) => {
                runs.push(String(job.data.sceneId));
                if (runs.length === 1) await held;
            },
            { connection: workerConnection as unknown as ConnectionOptions },
        );
        try {
            const schedule = () => scheduleProseCheck(ctx.workspaceId, 'active-a', { enqueue: toTestQueue(0, name) });
            await schedule();
            await until(async () => runs.length === 1);
            // The save lands while the first check runs: a plain job id would be ignored here.
            await schedule();
            release();
            await until(async () => runs.length === 2);
            expect(runs).toEqual(['active-a', 'active-a']);
        } finally {
            release();
            await worker.close();
            const q = new Queue(name, { connection: workerConnection as unknown as ConnectionOptions });
            await q.obliterate({ force: true });
            await q.close();
            await closeRedisClient(workerConnection);
        }
    });
});

describe('end to end: a save, the debounced job, the real worker, the margin', () => {
    let worker: Worker;
    let workerConnection: Redis;
    beforeAll(async () => {
        workerConnection = createRedisClient(testRedisUrl(), 'inkquisitor-prose-e2e-worker');
        worker = createJobWorker({ connection: workerConnection, log, queueName });
        await worker.waitUntilReady();
    });
    afterAll(async () => {
        await worker?.close();
        await closeRedisClient(workerConnection);
    });

    it('stores the check of the saved text and reads it CHECKED, each note with the text it covers', async () => {
        const { sceneId } = await newScene('<p>Placeholder.</p>', 'End to end');
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).status).toBe('NOT_CHECKED');
        const saved = await saveSceneText(ctx, bookId, sceneId, { html: '<p>He was very tired. The the door opened.</p>', baseRevision: 1 }, { enqueueProseCheck: toTestQueue(100) });
        expect(saved.proseCheck).toBe('SCHEDULED');
        const view = await until(async () => {
            const v = await getSceneProseChecks(ctx, bookId, sceneId);
            return v.status === 'CHECKED' ? v : null;
        });
        expect(view.findings.map((f) => [f.ruleId, f.matched])).toEqual([
            ['intensifiers', 'very'],
            ['repeated-words', 'the'],
        ]);
        expect(view.findings[0].suggestion).toMatchObject({ replacement: '' });
        expect(view.checkedRevision).toBe(saved.revision);
    });
});

describe('the job', () => {
    it('a newer save supersedes a running check: nothing stale is stored', async () => {
        const { sceneId, revision } = await newScene('<p>He was very tired.</p>', 'Superseded');
        const r = await executeProseCheck(
            { workspaceId: ctx.workspaceId, sceneId },
            { beforeStore: async () => void (await saveSceneText(ctx, bookId, sceneId, { html: '<p>He was tired.</p>', baseRevision: revision }, { enqueueProseCheck: async () => undefined })) },
        );
        expect(r.outcome).toBe('SUPERSEDED');
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).status).toBe('NOT_CHECKED');
        // Its own check then runs over the newer text.
        expect((await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId })).outcome).toBe('CHECKED');
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).findings).toEqual([]);
    });

    it('a details-only save (a new revision, the same text) leaves the check standing', async () => {
        const { sceneId } = await newScene('<p>He was very tired.</p>', 'Details only');
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId });
        await prisma.manuscriptScene.update({ where: { id: sceneId }, data: { revision: { increment: 1 } } });
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).status).toBe('CHECKED');
    });

    it('a dismissal holds while its sentence is unchanged and the note returns when the sentence changes', async () => {
        const { sceneId, revision } = await newScene('<p>He was very tired. The sea rose.</p>', 'Dismissal');
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId });
        const first = await getSceneProseChecks(ctx, bookId, sceneId);
        const note = first.findings.find((f) => f.ruleId === 'intensifiers')!;
        await dismissProseFinding(ctx, bookId, { findingId: note.id });
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).findings.map((f) => f.ruleId)).not.toContain('intensifiers');
        // Another sentence changes: the note stays dismissed.
        const r2 = await saveSceneText(ctx, bookId, sceneId, { html: '<p>He was very tired. The sea fell.</p>', baseRevision: revision }, { enqueueProseCheck: async () => undefined });
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId });
        const second = await getSceneProseChecks(ctx, bookId, sceneId);
        expect(second.findings.map((f) => f.ruleId)).not.toContain('intensifiers');
        expect(second.dismissed).toBe(1);
        // Its own sentence changes: the note is raised again.
        await saveSceneText(ctx, bookId, sceneId, { html: '<p>He was very weary. The sea fell.</p>', baseRevision: r2.revision }, { enqueueProseCheck: async () => undefined });
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId });
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).findings.map((f) => f.ruleId)).toContain('intensifiers');
        // Clearing brings every dismissed note back.
        expect((await clearProseDismissals(ctx, bookId)).cleared).toBeGreaterThanOrEqual(1);
    });

    it('a rule turned off for the book hides its notes at once, and on again shows them', async () => {
        const { sceneId } = await newScene('<p>The the harbour was empty.</p>', 'Rule off');
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId });
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).findings.map((f) => f.ruleId)).toContain('repeated-words');
        await saveProseCheckSettings(ctx, bookId, { alexEnabled: false, rulesOff: ['repeated-words'] });
        const off = await getSceneProseChecks(ctx, bookId, sceneId);
        expect(off.findings.map((f) => f.ruleId)).not.toContain('repeated-words');
        expect(off.hiddenByRule).toBeGreaterThanOrEqual(1);
        await saveProseCheckSettings(ctx, bookId, { alexEnabled: false, rulesOff: [] });
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).findings.map((f) => f.ruleId)).toContain('repeated-words');
        await expect(saveProseCheckSettings(ctx, bookId, { alexEnabled: false, rulesOff: ['inclusive-language'] })).rejects.toMatchObject({ details: { reason: 'UNKNOWN_RULE' } });
    });

    it('the inclusive-language check, turned on, reads narration and never speech; turning it on marks old checks OUTDATED', async () => {
        const book = (await createBook(ctx, { title: 'Alex book' })).id;
        const chapter = await createChapter(ctx, book, { title: 'One' });
        const scene = await createScene(ctx, book, { chapterId: chapter.id, title: 'Alex' });
        await saveSceneText(ctx, book, scene.id, { html: '<p>“The chairman is late,” she said. The fireman waited.</p>', baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId: scene.id });
        expect((await getSceneProseChecks(ctx, book, scene.id)).findings.map((f) => f.ruleId)).not.toContain('inclusive-language');
        await saveProseCheckSettings(ctx, book, { alexEnabled: true, rulesOff: [] });
        expect((await getSceneProseChecks(ctx, book, scene.id)).status).toBe('OUTDATED');
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId: scene.id });
        const view = await getSceneProseChecks(ctx, book, scene.id);
        expect(view.status).toBe('CHECKED');
        expect(view.findings.filter((f) => f.ruleId === 'inclusive-language').map((f) => f.matched)).toEqual(['fireman']);
    });

    it('a style sheet change marks a check OUTDATED, and the new check runs its rules', async () => {
        const book = (await createBook(ctx, { title: 'Sheet book' })).id;
        bookId = book;
        const { sceneId } = await newScene('<p>The colour faded. She walks home.</p>', 'Sheet');
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId });
        const before = await getSceneProseChecks(ctx, bookId, sceneId);
        expect(before.rulesNotRun).toEqual(expect.arrayContaining(['tense-slip', 'spelling-variant']));
        const sheetId = await styleSheet([
            { key: 'check_tense', value: 'past' },
            { key: 'check_spelling', value: 'american' },
        ]);
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).status).toBe('OUTDATED');
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId });
        const after = await getSceneProseChecks(ctx, bookId, sceneId);
        expect(after.styleSheetElementId).toBe(sheetId);
        expect(after.findings.map((f) => [f.ruleId, f.matched])).toEqual(
            expect.arrayContaining([
                ['spelling-variant', 'colour'],
                ['tense-slip', 'walks'],
            ]),
        );
        expect((await getProseCheckSettings(ctx, bookId)).styleSheet?.elementId).toBe(sheetId);
    });

    it('stores nothing in clear: the detail and the baseline are envelopes, a dismissal is a keyed hash', async () => {
        const MARK = 'Zephyrquill';
        bookId = (await createBook(ctx, { title: 'Clear book' })).id;
        const { sceneId } = await newScene(`<p>${'The harbour was quiet. '.repeat(40)}${MARK} ${MARK} ${MARK} ${MARK} was very loud.</p>`, 'Clear');
        await styleSheet([{ key: 'avoided_words', value: [MARK.toLowerCase()] }]);
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId });
        const view = await getSceneProseChecks(ctx, bookId, sceneId);
        const banned = view.findings.find((f) => f.ruleId === 'banned-words')!;
        expect(banned.params.word).toBe(MARK);
        await dismissProseFinding(ctx, bookId, { findingId: banned.id });
        const pg = new Client({ connectionString: process.env.DATABASE_URL });
        await pg.connect();
        try {
            const findings = await pg.query('SELECT detail, "sentenceKey" FROM "ProseFinding" WHERE "workspaceId" = $1', [ctx.workspaceId]);
            expect(findings.rows.length).toBeGreaterThan(0);
            for (const row of findings.rows) {
                expect(row.detail).toMatch(/^v2:/);
                expect(row.sentenceKey).toMatch(/^[0-9a-f]{64}$/);
            }
            const all = JSON.stringify((await pg.query('SELECT * FROM "ProseFinding" WHERE "workspaceId" = $1', [ctx.workspaceId])).rows);
            const dismissals = JSON.stringify((await pg.query('SELECT * FROM "ProseDismissal" WHERE "workspaceId" = $1', [ctx.workspaceId])).rows);
            const checks = JSON.stringify((await pg.query('SELECT * FROM "SceneProseCheck" WHERE "workspaceId" = $1', [ctx.workspaceId])).rows);
            const baselines = (await pg.query('SELECT baseline FROM "ProseBookBaseline" WHERE "workspaceId" = $1', [ctx.workspaceId])).rows;
            for (const blob of [all, dismissals, checks, JSON.stringify(baselines)]) expect(blob.toLowerCase()).not.toContain(MARK.toLowerCase());
            for (const b of baselines) expect(b.baseline).toMatch(/^v2:/);
        } finally {
            await pg.end();
        }
    });

    it('another workspace reads none of it; a reader reads and cannot act', async () => {
        const { sceneId } = await newScene('<p>He was very tired.</p>', 'Isolation');
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId });
        const stranger = workspaceCtx(await createAccount());
        await expect(getSceneProseChecks(stranger, bookId, sceneId)).rejects.toBeInstanceOf(NotFoundError);
        const reader = { ...workspaceCtx({ userId: ctx.userId, workspaceId: ctx.workspaceId, workspaceSlug: ctx.workspaceSlug }, 'READER') };
        expect((await getSceneProseChecks(reader, bookId, sceneId)).status).toBe('CHECKED');
        await expect(requestSceneProseCheck(reader, bookId, sceneId, { enqueue: async () => undefined })).rejects.toMatchObject({ status: 403 });
    });

    it('a chapter re-run queues every scene; a deleted scene takes its check with it', async () => {
        const chapter = await createChapter(ctx, bookId, { title: 'Re-run' });
        const a = await createScene(ctx, bookId, { chapterId: chapter.id, title: 'A' });
        const b = await createScene(ctx, bookId, { chapterId: chapter.id, title: 'B' });
        const queued: string[] = [];
        const r = await rerunChapterProseChecks(ctx, bookId, chapter.id, { enqueue: async (p) => void queued.push(p.sceneId) });
        expect(r).toEqual({ queued: 2, notQueued: 0, scheduled: 'SCHEDULED' });
        expect(queued.sort()).toEqual([a.id, b.id].sort());
        await saveSceneText(ctx, bookId, a.id, { html: '<p>Very well.</p>', baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
        await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId: a.id });
        await deleteScene(ctx, bookId, a.id);
        expect(await prisma.sceneProseCheck.count({ where: { sceneId: a.id } })).toBe(0);
        expect((await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId: a.id })).outcome).toBe('SCENE_GONE');
    });

    it('a check past the workspace’s minute goes back on the queue and runs nothing', async () => {
        const { sceneId } = await newScene('<p>He was very tired.</p>', 'Rate');
        const requeued: unknown[] = [];
        const r = await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId }, { charge: () => 5_000, requeue: async (p, o) => void requeued.push({ p, o }) });
        expect(r.outcome).toBe('RATE_LIMITED');
        expect(requeued).toEqual([{ p: { workspaceId: ctx.workspaceId, sceneId }, o: expect.objectContaining({ delay: 5_000 }) }]);
        expect((await getSceneProseChecks(ctx, bookId, sceneId)).status).toBe('NOT_CHECKED');
    });

    it('a workspace whose key will not unwrap fails only its own check, named, and another workspace’s runs', async () => {
        const broken = workspaceCtx(await createAccount());
        const book = (await createBook(broken, { title: 'Broken key' })).id;
        const chapter = await createChapter(broken, book, { title: 'One' });
        const scene = await createScene(broken, book, { chapterId: chapter.id, title: 'Locked' });
        await saveSceneText(broken, book, scene.id, { html: '<p>He was very tired.</p>', baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
        const row = await runWithoutRls({ reason: 'test' }, (db) => db.workspace.findUniqueOrThrow({ where: { id: broken.workspaceId }, select: { encryptedDek: true } }));
        const wrapped = row.encryptedDek!;
        const at = Math.floor(wrapped.length * 0.6);
        try {
            await runWithoutRls({ reason: 'test' }, (db) => db.workspace.update({ where: { id: broken.workspaceId }, data: { encryptedDek: wrapped.slice(0, at) + (wrapped[at] === 'A' ? 'B' : 'A') + wrapped.slice(at + 1) } }));
            workspaceKeys.clear(broken.workspaceId);
            await expect(executeProseCheck({ workspaceId: broken.workspaceId, sceneId: scene.id })).resolves.toEqual({ outcome: 'FAILED', findings: 0 });
            const { sceneId } = await newScene('<p>He was very tired.</p>', 'Healthy');
            expect((await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId })).outcome).toBe('CHECKED');
        } finally {
            await runWithoutRls({ reason: 'test' }, (db) => db.workspace.update({ where: { id: broken.workspaceId }, data: { encryptedDek: wrapped } }));
            workspaceKeys.clear(broken.workspaceId);
        }
    });
});
