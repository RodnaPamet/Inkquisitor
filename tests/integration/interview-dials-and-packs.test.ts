/**
 * Dials, defaults and pack mounting against a real database (Phase 2.3):
 * defaults resolved into a session under RLS, the routes, several personas,
 * the pins written once and compared at use, and production's gate (D11).
 * The deterministic fake generator words the questions; no model is called.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { prisma } from '@/lib/db';
import { tokenBudgetFor } from '@/lib/interview/session-length';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { createBook, deleteBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { closeRound, nextRound, startInterview } from '@/app-layer/usecases/interviews';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import type { InterviewView } from '@/app-layer/usecases/interview-state';
import { getBookInterviewDefaults, getWorkspaceInterviewDefaults, setBookInterviewDefaults, setWorkspaceInterviewDefaults } from '@/app-layer/usecases/interview-defaults';
import { embedderFrom } from '@/app-layer/usecases/question-embeddings';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { AppError } from '@/lib/errors/types';
import { getPacks, loadPacks, PACKS_DIR } from '@/lib/interview/packs';
import { GET as packsRoute } from '@/app/api/w/[workspaceSlug]/interview-packs/route';
import { GET as wsDefaultsGet, PUT as wsDefaultsPut } from '@/app/api/w/[workspaceSlug]/interview-defaults/route';
import { GET as bookDefaultsGet, PUT as bookDefaultsPut } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interview-defaults/route';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

const embedder = embedderFrom(new StubEmbeddingProvider());
const tmpDirs: string[] = [];

afterAll(async () => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    await prisma.$disconnect();
});

let owner: Awaited<ReturnType<typeof createAccount>>;
let other: Awaited<ReturnType<typeof createAccount>>;
let ctx: ReturnType<typeof workspaceCtx>;
let bookId: string;

beforeAll(async () => {
    owner = await createAccount();
    other = await createAccount();
    ctx = workspaceCtx(owner);
    session.userId = owner.userId;
    bookId = (await createBook(ctx, { title: 'The Dial Book' })).id;
});

async function character(name: string): Promise<string> {
    return (await createElement(ctx, bookId, { kind: 'CHARACTER', name })).id;
}

/** Answer every question of the open round, then close it: the next round has new fields to ask. */
async function answerAndClose(view: InterviewView): Promise<void> {
    for (const q of view.round!.questions) {
        const body = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: 'Settled by the author.' };
        await answerQuestion(ctx, bookId, view.session.id, q.id, body);
    }
    await closeRound(ctx, bookId, view.session.id, String(view.round!.number), {});
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; details: Record<string, unknown> }> {
    try {
        await p;
    } catch (err) {
        if (err instanceof AppError) return { status: err.status, details: (err.details ?? {}) as Record<string, unknown> };
        if (err instanceof ZodError) return { status: 400, details: {} };
        throw err;
    }
    throw new Error('expected a refusal');
}

describe('defaults and precedence', () => {
    it('a session takes each dial from its request, then the book, then the workspace, then the code', async () => {
        const book = (await createBook(ctx, { title: 'Precedence' })).id;
        const el = (await createElement(ctx, book, { kind: 'THEME', name: 'Promises' })).id;
        await setWorkspaceInterviewDefaults(ctx, { depth: 2, detail: 1, offerRecommended: false });
        await setBookInterviewDefaults(ctx, book, { detail: 4, personaKeys: ['gentle-mentor'] });
        const view = await startInterview(ctx, book, { scope: 'ELEMENT', elementId: el, personaKeys: ['socratic', 'target-reader'] }, { generator: fakeGenerator(), embedder });
        expect(view.session).toMatchObject({ dials: { depth: 2, detail: 4 }, personaKeys: ['socratic', 'target-reader'], offerRecommended: false, preferChoice: false });
        // The session's budgets follow its resolved dials and its length (Phase 4.4: the default four rounds, whatever the depth).
        const row = await prisma.interviewSession.findUniqueOrThrow({ where: { id: view.session.id } });
        expect(row).toMatchObject({ lengthMode: 'ROUNDS', roundBudget: 4, questionBudget: null, tokenBudget: tokenBudgetFor({ mode: 'ROUNDS', rounds: 4 }, 4, 2), generatorsOff: [] });
        const audit = await prisma.auditLog.findFirst({ where: { workspaceId: owner.workspaceId, action: 'INTERVIEW_STARTED', entityId: view.session.id } });
        expect(audit?.detailsJson).toMatchObject({ dialSources: { depth: 'workspace', detail: 'book', personaKeys: 'session', offerRecommended: 'workspace', preferChoice: 'code' } });
        // The workspace layer is replaced whole: what a PUT leaves out passes on.
        await setWorkspaceInterviewDefaults(ctx, {});
    });

    it('a layer reads back with what it resolves to and what that does', async () => {
        await setWorkspaceInterviewDefaults(ctx, { depth: 5, preferChoice: true });
        const book = (await createBook(ctx, { title: 'Read back' })).id;
        await setBookInterviewDefaults(ctx, book, { detail: 5, personaKeys: [] });
        const ws = await getWorkspaceInterviewDefaults(ctx);
        expect(ws.stored).toEqual({ depth: 5, detail: null, personaKeys: null, offerRecommended: null, preferChoice: true, generatorsOff: null });
        const bk = await getBookInterviewDefaults(ctx, book);
        expect(bk.stored).toEqual({ depth: null, detail: 5, personaKeys: [], offerRecommended: null, preferChoice: null, generatorsOff: null });
        expect(bk.effective).toEqual({ depth: 5, detail: 5, personaKeys: [], offerRecommended: true, preferChoice: true, generatorsOff: [] });
        expect(bk.sources).toEqual({ depth: 'workspace', detail: 'book', personaKeys: 'book', offerRecommended: 'code', preferChoice: 'workspace', generatorsOff: 'code' });
        expect(bk.effects).toMatchObject({ ladderLayers: 6, roundBudget: 4, roundCap: 3, kindsAllowed: ['OPEN', 'SCENARIO'], generationCallsPerRound: 1 });
        await setWorkspaceInterviewDefaults(ctx, {});
    });

    it('refuses a bad layer, a READER’s write, and another workspace’s book', async () => {
        expect((await refusal(setWorkspaceInterviewDefaults(ctx, { personaKeys: ['socratic', 'socratic'] }))).status).toBe(400);
        expect((await refusal(setWorkspaceInterviewDefaults(ctx, { personaKeys: ['socratic', 'gentle-mentor', 'target-reader', 'devils-advocate'] }))).status).toBe(400);
        expect((await refusal(setWorkspaceInterviewDefaults(ctx, { depth: 9 }))).status).toBe(400);
        expect((await refusal(setWorkspaceInterviewDefaults(ctx, { surprise: 1 }))).status).toBe(400);
        const reader = workspaceCtx(owner, 'READER');
        expect((await refusal(setBookInterviewDefaults(reader, bookId, { depth: 1 }))).status).toBe(403);
        expect((await getBookInterviewDefaults(reader, bookId)).stored).toBeDefined();
        expect((await refusal(getBookInterviewDefaults(workspaceCtx(other), bookId))).status).toBe(404);
    });

    it('a deleted book has no defaults to read or write: 404, as every route of a deleted book', async () => {
        const book = (await createBook(ctx, { title: 'Soon gone' })).id;
        await setBookInterviewDefaults(ctx, book, { depth: 2 });
        await deleteBook(ctx, book);
        expect((await refusal(getBookInterviewDefaults(ctx, book))).status).toBe(404);
        expect((await refusal(setBookInterviewDefaults(ctx, book, { depth: 4 }))).status).toBe(404);
        expect((await prisma.bookInterviewDefaults.findUniqueOrThrow({ where: { bookId: book } })).depth).toBe(2);
    });

    it('is workspace-scoped: another workspace sees none of this one’s defaults, and the database refuses a bad row', async () => {
        await setWorkspaceInterviewDefaults(ctx, { depth: 1 });
        await setBookInterviewDefaults(ctx, bookId, { detail: 2 });
        const seen = await runInWorkspaceContext(workspaceCtx(other), async (db) => ({
            ws: await db.workspaceInterviewDefaults.count({ where: { workspaceId: owner.workspaceId } }),
            book: await db.bookInterviewDefaults.count({ where: { bookId } }),
        }));
        expect(seen).toEqual({ ws: 0, book: 0 });
        expect((await getWorkspaceInterviewDefaults(workspaceCtx(other))).stored.depth).toBeNull();
        await expect(prisma.$executeRaw`UPDATE "WorkspaceInterviewDefaults" SET "personaKeys" = '["socratic","socratic"]'::jsonb WHERE "workspaceId" = ${owner.workspaceId}`).rejects.toThrow(/personas_known/);
        await expect(prisma.$executeRaw`UPDATE "BookInterviewDefaults" SET "depth" = 0 WHERE "bookId" = ${bookId}`).rejects.toThrow(/dials_bounded/);
        await setWorkspaceInterviewDefaults(ctx, {});
        await setBookInterviewDefaults(ctx, bookId, {});
    });
});

describe('several personas (STORM’s perspectives)', () => {
    it('each persona words its share of the round, in its own call with its own pack, each question tagged with its name', async () => {
        // A kind session over three fresh characters: enough frontier fields for every persona's share.
        const book = (await createBook(ctx, { title: 'Three Voices' })).id;
        for (const name of ['Ada', 'Bram', 'Cleo']) await createElement(ctx, book, { kind: 'CHARACTER', name });
        const gen = fakeGenerator();
        const view = await startInterview(ctx, book, { scope: 'KIND', kind: 'CHARACTER', depth: 3, detail: 3, personaKeys: ['socratic', 'gentle-mentor', 'ruthless-editor'] }, { generator: gen, embedder });
        expect(view.session.personaKeys).toEqual(['socratic', 'gentle-mentor', 'ruthless-editor']);
        expect(gen.calls.map((c) => c.personaKey)).toEqual(['socratic', 'gentle-mentor', 'ruthless-editor']);
        expect(gen.calls[0].template.system).toContain('# Socratic');
        expect(gen.calls[1].template.system).toContain('# Gentle Mentor');
        expect(gen.calls[2].template.system).toContain('# Ruthless Editor');
        const qs = view.round!.questions.filter((q) => q.origin === 'MODEL');
        expect(new Set(qs.map((q) => q.personaKey))).toEqual(new Set(['socratic', 'gentle-mentor', 'ruthless-editor']));
        for (const q of qs) expect(q.personaName).toBe({ socratic: 'Socratic', 'gentle-mentor': 'Gentle Mentor', 'ruthless-editor': 'Ruthless Editor' }[q.personaKey!]);
        // Round-robin from the first persona: the targets are dealt in turn.
        expect(qs.map((q) => q.personaKey).slice(0, 3)).toEqual(['socratic', 'gentle-mentor', 'ruthless-editor']);
        // Rule 9, per call: each call's version names its packs.
        const round = await prisma.interviewRound.findFirstOrThrow({ where: { sessionId: view.session.id, number: 1 } });
        const calls = (round.metrics as { calls: Array<{ personaKey: string; promptVersion: string; packs: string[]; costBudgetMicroUsd: number }> }).calls;
        expect(calls.map((c) => c.personaKey)).toEqual(['socratic', 'gentle-mentor', 'ruthless-editor']);
        expect(new Set(calls.map((c) => c.promptVersion)).size).toBe(3);
        expect(calls[0].packs).toEqual(['craft-character@1', 'persona-socratic@1']);
        expect(calls.every((c) => c.costBudgetMicroUsd > 0)).toBe(true);
        // Phase 4.4 (D30): a KIND session with the relations generator on pins the relations pack too (its relations between characters are subjects).
        expect(view.session.packs!.map((p) => p.name)).toEqual(['craft-character', 'relations', 'persona-socratic', 'persona-gentle-mentor', 'persona-ruthless-editor']);
        // Each field is asked once a round, whichever persona words it (2.2's rule holds across personas).
        const refs = view.round!.questions.filter((q) => q.mode === 'FRONTIER').flatMap((q) => q.targetsFieldKeys.map((k) => `${q.elementId}:${k}`));
        expect(new Set(refs).size).toBe(refs.length);
    });

    it('the database holds at most three, known, none twice', async () => {
        const el = await character('Check');
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el, personaKeys: ['socratic'] }, { generator: fakeGenerator(), embedder });
        for (const keys of [['socratic', 'socratic'], ['socratic', 'gentle-mentor', 'target-reader', 'devils-advocate'], ['the-critic']]) {
            await expect(prisma.$executeRaw`UPDATE "InterviewSession" SET "personaKeys" = ${keys} WHERE "id" = ${view.session.id}`).rejects.toThrow(/personas_known/);
        }
        expect((await refusal(startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el, personaKeys: ['socratic', 'gentle-mentor', 'target-reader', 'devils-advocate'] }, { generator: fakeGenerator(), embedder }))).status).toBe(400);
    });
});

describe('pack pins', () => {
    it('are written when the session starts, once: the database refuses any change, for every role', async () => {
        const el = await character('Pinned');
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el, personaKeys: ['target-reader'] }, { generator: fakeGenerator(), embedder });
        const packs = getPacks();
        expect(view.session.packs).toEqual([
            { name: 'craft-character', version: 1, contentHash: packs.files['craft-character'].contentHash, recordKind: 'structural' },
            { name: 'persona-target-reader', version: 1, contentHash: packs.files['persona-target-reader'].contentHash, recordKind: 'structural' },
        ]);
        await expect(prisma.$executeRaw`UPDATE "InterviewSession" SET "packPins" = '[]'::jsonb WHERE "id" = ${view.session.id}`).rejects.toThrow(/PACK_PINS_IMMUTABLE/);
        await expect(prisma.$executeRaw`UPDATE "InterviewSession" SET "packPins" = NULL WHERE "id" = ${view.session.id}`).rejects.toThrow(/PACK_PINS_IMMUTABLE/);
        // Every other column still moves.
        expect(await prisma.$executeRaw`UPDATE "InterviewSession" SET "tokensUsed" = "tokensUsed" WHERE "id" = ${view.session.id}`).toBe(1);
        // And the application role, inside its own workspace, is refused the same.
        await expect(
            runInWorkspaceContext(ctx, (db) => db.$executeRaw`UPDATE "InterviewSession" SET "packPins" = '[]'::jsonb WHERE "id" = ${view.session.id}`),
        ).rejects.toThrow(/PACK_PINS_IMMUTABLE/);
    });

    it('a session from before pinning (2.2, NULL pins) is never pinned later: it ENDS once (PACK_NOT_PINNED), a retry meets an ended interview and writes nothing (issue #36, item 2), and the database refuses a late pin', async () => {
        const el = await character('Before Pinning');
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el, depth: 3, detail: 3 }, { generator: fakeGenerator(), embedder });
        await answerAndClose(view);
        // A 2.2 row: no pins. Only a superuser with triggers off can make one now.
        await prisma.$transaction([prisma.$executeRaw`SET LOCAL session_replication_role = replica`, prisma.$executeRaw`UPDATE "InterviewSession" SET "packPins" = NULL WHERE "id" = ${view.session.id}`]);
        const gen = fakeGenerator();
        const ended = await nextRound(ctx, bookId, view.session.id, { generator: gen, embedder });
        expect(ended.session).toMatchObject({ status: 'STOPPED', stopReason: 'PACK_CHANGED', stopDetail: { problem: 'PACK_NOT_PINNED' }, packs: null });
        expect(gen.calls).toHaveLength(0);
        const snapshot = async () => ({
            session: await prisma.interviewSession.findUniqueOrThrow({ where: { id: view.session.id }, select: { status: true, stopReason: true, updatedAt: true, endedAt: true } }),
            audit: await prisma.auditLog.count({ where: { workspaceId: owner.workspaceId, entityId: view.session.id } }),
        });
        const before = await snapshot();
        for (let i = 0; i < 2; i++) {
            const r = await refusal(nextRound(ctx, bookId, view.session.id, { generator: gen, embedder }));
            expect(r).toMatchObject({ status: 409, details: { reason: 'INTERVIEW_ENDED' } });
        }
        expect(await snapshot()).toEqual(before);
        expect(gen.calls).toHaveLength(0);
        expect(await prisma.interviewRound.count({ where: { sessionId: view.session.id } })).toBe(1);
        await expect(prisma.$executeRaw`UPDATE "InterviewSession" SET "packPins" = '[]'::jsonb WHERE "id" = ${view.session.id}`).rejects.toThrow(/PACK_PINS_IMMUTABLE/);
    });

    // A BOOK session mounts and verifies all sixteen craft packs (each record replayed) and, since 4.0, reads the
    // book's source set too: 4.5–4.8 s on a loaded runner, so Jest's 5 s default decided this test by the clock.
    it('a book session pins the craft pack of every kind', async () => {
        const view = await startInterview(ctx, bookId, { scope: 'BOOK', depth: 1, detail: 1 }, { generator: fakeGenerator(), embedder });
        expect(view.session.packs!.filter((p) => p.name.startsWith('craft-'))).toHaveLength(16);
    }, 30_000);

    it('a session refuses a pack whose file changed after it started (PACK_CHANGED), and resumes when the file is restored', async () => {
        const el = await character('Changed Under It');
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el, depth: 3, detail: 3, personaKeys: ['socratic'] }, { generator: fakeGenerator(), embedder });
        await answerAndClose(view);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-packs-'));
        tmpDirs.push(dir);
        fs.cpSync(PACKS_DIR, dir, { recursive: true });
        const file = path.join(dir, 'personas/socratic/PACK.md');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('calm, measured and curious', 'calm and curious'));
        const changed = loadPacks(dir);

        const gen = fakeGenerator();
        const paused = await nextRound(ctx, bookId, view.session.id, { generator: gen, embedder, packs: changed });
        expect(paused.session).toMatchObject({ status: 'PAUSED', stopReason: 'PACK_CHANGED', stopDetail: { problem: 'PACK_CHANGED', packs: ['persona-socratic'] } });
        expect(gen.calls).toHaveLength(0);
        // Asked again while the file is still changed: already paused for exactly this, nothing written (issue #36, item 2).
        const auditBefore = await prisma.auditLog.count({ where: { workspaceId: owner.workspaceId, entityId: view.session.id } });
        const updatedBefore = (await prisma.interviewSession.findUniqueOrThrow({ where: { id: view.session.id }, select: { updatedAt: true } })).updatedAt;
        await nextRound(ctx, bookId, view.session.id, { generator: gen, embedder, packs: changed });
        expect(await prisma.auditLog.count({ where: { workspaceId: owner.workspaceId, entityId: view.session.id } })).toBe(auditBefore);
        expect((await prisma.interviewSession.findUniqueOrThrow({ where: { id: view.session.id }, select: { updatedAt: true } })).updatedAt).toEqual(updatedBefore);
        expect(await prisma.interviewRound.count({ where: { sessionId: view.session.id } })).toBe(1);

        const resumed = await nextRound(ctx, bookId, view.session.id, { generator: fakeGenerator(), embedder });
        expect(resumed.session.status).toBe('ACTIVE');
        expect(resumed.round).toMatchObject({ number: 2, status: 'OPEN' });
    });
});

describe('production’s gate (D11): no real-model record, no interview', () => {
    it('refuses 503 PACKS_NOT_MOUNTABLE, naming each pack, and writes nothing', async () => {
        const el = await character('Production');
        const before = await prisma.interviewSession.count({ where: { bookId } });
        const r = await refusal(startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el, personaKeys: ['socratic'] }, { generator: fakeGenerator(), embedder, packRecordMode: 'model' }));
        expect(r.status).toBe(503);
        expect(r.details).toEqual({
            reason: 'PACKS_NOT_MOUNTABLE',
            packs: [
                { name: 'craft-character', reason: 'STRUCTURAL_RECORD_REFUSED' },
                { name: 'persona-socratic', reason: 'STRUCTURAL_RECORD_REFUSED' },
            ],
        });
        expect(await prisma.interviewSession.count({ where: { bookId } })).toBe(before);
    });

    it('a session started where packs mount is refused its next round where they do not, with nothing written', async () => {
        const el = await character('Moved');
        const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId: el, depth: 3 }, { generator: fakeGenerator(), embedder });
        await answerAndClose(view);
        const r = await refusal(nextRound(ctx, bookId, view.session.id, { generator: fakeGenerator(), embedder, packRecordMode: 'model' }));
        expect(r).toMatchObject({ status: 503, details: { reason: 'PACKS_NOT_MOUNTABLE' } });
        expect(await prisma.interviewRound.count({ where: { sessionId: view.session.id } })).toBe(1);
    });
});

describe('the routes', () => {
    type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;
    async function call(handler: Handler, url: string, params: Record<string, string>, method = 'GET', body?: unknown) {
        const req = new NextRequest(`http://localhost${url}`, {
            method,
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.33' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const res = await handler(req, { params: Promise.resolve({ workspaceSlug: owner.workspaceSlug, ...params }) as Promise<never> });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    }

    it('GET interview-packs lists the six personas, the panel’s three, sixteen craft packs (one per kind) and the relations pack with their mount status, and no pack text', async () => {
        const res = await call(packsRoute, `/api/w/${owner.workspaceSlug}/interview-packs`, {});
        expect(res.status).toBe(200);
        const body = res.json as { recordMode: string; personas: Array<Record<string, unknown>>; craft: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>>; mountable: number; total: number };
        expect(body.recordMode).toBe('structural');
        expect(body.personas.map((p) => p.displayName)).toEqual(['Gentle Mentor', 'Ruthless Editor', 'Socratic', "Devil's Advocate", 'Target Reader', 'Genre Specialist', 'Panel: Target Reader', 'Panel: Ruthless Editor', 'Panel: Genre Specialist']);
        // Phase 4.3 (D29): the book-level panel's three packs are listed with their mount status too, by their own keys
        // (the setup sheet offers them only through its Panel preset, never in the persona picker).
        expect(body.personas.slice(6).map((p) => p.key)).toEqual(['panel-target-reader', 'panel-ruthless-editor', 'panel-genre-specialist']);
        expect(body.craft).toHaveLength(16);
        // Phase 3.3 (D24): one relations pack beside them, its own list.
        expect(body.relations.map((p) => p.name)).toEqual(['relations']);
        expect(body).toMatchObject({ mountable: 26, total: 26 });
        expect(body.personas[0]).toMatchObject({ name: 'persona-gentle-mentor', mountable: true, refusal: null, recordKind: 'structural', coverage: null });
        expect(body.craft.find((c) => c.key === 'CHARACTER')).toMatchObject({ name: 'craft-character', coverage: getPacks().craft.CHARACTER.coverage });
        expect(JSON.stringify(body)).not.toContain('## How to question');
    });

    it('PUT and GET the workspace’s and the book’s defaults', async () => {
        const put = await call(wsDefaultsPut, `/api/w/${owner.workspaceSlug}/interview-defaults`, {}, 'PUT', { depth: 4, personaKeys: ['devils-advocate'] });
        expect(put.status).toBe(200);
        expect(put.json.defaults).toMatchObject({ stored: { depth: 4, personaKeys: ['devils-advocate'] }, effective: { depth: 4 } });
        const get = await call(wsDefaultsGet, `/api/w/${owner.workspaceSlug}/interview-defaults`, {});
        expect(get.json.defaults).toMatchObject({ stored: { depth: 4 } });

        const bput = await call(bookDefaultsPut, `/api/w/${owner.workspaceSlug}/books/${bookId}/interview-defaults`, { bookId }, 'PUT', { depth: 1 });
        expect(bput.status).toBe(200);
        const bget = await call(bookDefaultsGet, `/api/w/${owner.workspaceSlug}/books/${bookId}/interview-defaults`, { bookId });
        expect(bget.json.defaults).toMatchObject({ effective: { depth: 1, personaKeys: ['devils-advocate'] }, sources: { depth: 'book', personaKeys: 'workspace' } });

        const bad = await call(bookDefaultsPut, `/api/w/${owner.workspaceSlug}/books/${bookId}/interview-defaults`, { bookId }, 'PUT', { depth: 'deep' });
        expect(bad.status).toBe(400);
        await setWorkspaceInterviewDefaults(ctx, {});
        await setBookInterviewDefaults(ctx, bookId, {});
    });
});
