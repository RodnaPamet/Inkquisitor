/**
 * The research agent's fit step reaches the manuscript (Phase 5.1): a brief scoped to a chapter shows the fit step
 * its scenes (fenced data, never the gather request), a SCENE_NOTE citing a finding is stored as a proposal, and
 * accepting it writes the scene's NOTE — one RESEARCH note version naming the proposal and its findings — and never
 * the scene's text (D3). A note that writes prose, or rests on the scene rather than the findings, is refused. A
 * brief quoting the manuscript is refused like one quoting the bible (D9).
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene } from '@/app-layer/usecases/manuscript';
import { getScene, saveSceneText } from '@/app-layer/usecases/manuscript-scenes';
import { createResearchBrief, dispatchResearchRun } from '@/app-layer/usecases/research-briefs';
import { executeResearchRun } from '@/app-layer/usecases/research-run';
import { getResearchRunReview } from '@/app-layer/usecases/research-pages';
import { acceptResearchProposal } from '@/app-layer/usecases/research-review';
import { defaultResearcher } from '@/lib/research/model-seam';
import { AppError } from '@/lib/errors/types';
import { fakeAnthropic, setFakeApiKey, type FakeTurn } from '../helpers/fake-anthropic';
import { gatherEvents, MOUNTED_GATE, type FakePage } from '../helpers/research';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

let undoKey: () => void;
beforeAll(() => {
    undoKey = setFakeApiKey();
});
afterAll(async () => {
    undoKey();
    await prisma.$disconnect();
});

const PAGE: FakePage = {
    url: 'https://maritime.example.org/fog',
    title: 'Signals in fog',
    text: 'In fog, ships fired guns or rang bells at fixed intervals, because flags and lanterns could not be seen. From 1817 merchant ships used Marryat\'s Code of numbered signal flags.',
};
const SCENE_PROSE = 'Mara stood at the rail and watched the lanterns drift closer through the fog.';

function turns(fit: unknown): FakeTurn[] {
    return [
        { kind: 'events', events: gatherEvents({ query: 'how ships signalled in fog', pages: [PAGE] }) },
        {
            kind: 'respond',
            answer: () => ({
                kind: 'text',
                text: JSON.stringify({
                    findings: [
                        {
                            claim: 'In fog, ships fired guns or rang bells at fixed intervals.',
                            summary: 'In fog, ships fired guns or rang bells at fixed intervals, because flags and lanterns could not be seen.',
                            confidence: 'HIGH',
                            citations: [{ ref: 'web.1', quote: 'In fog, ships fired guns or rang bells at fixed intervals, because flags and lanterns could not be seen.' }],
                        },
                    ],
                }),
            }),
        },
        { kind: 'respond', answer: () => ({ kind: 'text', text: JSON.stringify(fit) }) },
    ];
}

const note = (value: string, sceneRef = 's1') => ({ op: 'SCENE_NOTE', elementId: null, fieldKey: null, value, newKind: null, newName: null, newSummary: null, rationale: 'The scene is set in fog.', cites: ['f1'], sceneRef });

async function setup() {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title: 'The Cape' })).id;
    const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara Quell' });
    const chapter = await createChapter(ctx, bookId, { title: 'Chapter three' });
    const scene = await createScene(ctx, bookId, { chapterId: chapter.id, title: 'Fog off the cape' });
    await saveSceneText(ctx, bookId, scene.id, { html: `<p>${SCENE_PROSE}</p>`, baseRevision: 0 });
    return { ctx, bookId, elementId: el.id, chapterId: chapter.id, sceneId: scene.id };
}

async function run(s: Awaited<ReturnType<typeof setup>>, fit: unknown) {
    const brief = await createResearchBrief(s.ctx, s.bookId, { question: 'How did ships signal to each other in fog?', purpose: 'My captain must warn another ship.', scopeElementIds: [s.elementId], scopeChapterIds: [s.chapterId], depth: 'QUICK' });
    const fake = fakeAnthropic(turns(fit));
    const { runId } = await dispatchResearchRun(s.ctx, s.bookId, brief.id, { gate: MOUNTED_GATE, enqueue: async () => undefined });
    const result = await executeResearchRun({ workspaceId: s.ctx.workspaceId, runId }, { gate: MOUNTED_GATE, researcher: (c) => defaultResearcher(c, { fetch: fake.fetch }) });
    return { fake, runId, result };
}

it('shows the scope chapter\'s scenes to the fit step only, stores a cited note, and accepting it writes the note, never the text', async () => {
    const s = await setup();
    const { fake, runId, result } = await run(s, { proposals: [note('In fog, ships fired guns or rang bells at fixed intervals.')], noFit: [] });
    expect(result.outcome).toBe('OK');
    // D9 / D15: the gather request carries the brief, nothing of the manuscript; the fit request carries the scene.
    expect(JSON.stringify(fake.requests[0])).not.toContain('Mara stood at the rail');
    expect(JSON.stringify(fake.requests[2])).toContain('Mara stood at the rail');

    const review = await getResearchRunReview(s.ctx, s.bookId, runId);
    expect(review.sceneNotes).toHaveLength(1);
    const p = review.sceneNotes[0];
    expect(p).toMatchObject({ sceneId: s.sceneId, sceneTitle: 'Fog off the cape', note: 'In fog, ships fired guns or rang bells at fixed intervals.', status: 'PENDING' });

    const before = await getScene(s.ctx, s.bookId, s.sceneId);
    const decision = await acceptResearchProposal(s.ctx, s.bookId, p.id, {});
    expect(decision).toMatchObject({ status: 'ACCEPTED', versionNumber: 1 });
    const after = await getScene(s.ctx, s.bookId, s.sceneId);
    expect(after.text).toBe(before.text);
    expect(after.revision).toBe(before.revision);
    expect(after.note).toBe('In fog, ships fired guns or rang bells at fixed intervals.');
    const versions = await prisma.sceneNoteVersion.findMany({ where: { sceneId: s.sceneId } });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ source: 'RESEARCH', sourceResearchProposalId: p.id, sourceFindingIds: p.findingIds });
    expect(await prisma.sceneVersion.count({ where: { sceneId: s.sceneId } })).toBe(1);
});

it('refuses a note that writes prose, one that rests on the scene rather than the findings, and one on a scene never shown', async () => {
    const s = await setup();
    const { runId, result } = await run(s, {
        proposals: [
            note('"Fire the gun, Mara," the mate said as the fog closed over the deck.'),
            note(SCENE_PROSE),
            note('In fog, ships fired guns or rang bells at fixed intervals.', 's7'),
        ],
        noFit: [],
    });
    expect(result.outcome).toBe('OK');
    expect((await getResearchRunReview(s.ctx, s.bookId, runId)).sceneNotes).toEqual([]);
    const run_ = await prisma.researchRun.findUniqueOrThrow({ where: { id: runId } });
    const refusals = (run_.metrics as { fitRefusals: Record<string, number> }).fitRefusals;
    expect(refusals).toMatchObject({ WRITES_PROSE: 1, UNSOURCED_SENTENCE: 1, TARGETS_OUTSIDE_SCOPE: 1 });
});

it('refuses a brief quoting the manuscript (D9), and a chapter of another book', async () => {
    const s = await setup();
    let err: unknown;
    try {
        await createResearchBrief(s.ctx, s.bookId, { question: `Why did she watch the lanterns drift closer through the fog?`, purpose: 'Research.', depth: 'QUICK' });
    } catch (e) {
        err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).details).toMatchObject({ reason: 'BRIEF_QUOTES_BIBLE' });

    const other = await setup();
    await expect(createResearchBrief(s.ctx, s.bookId, { question: 'Fog signals?', purpose: 'Research.', scopeChapterIds: [other.chapterId], depth: 'QUICK' })).rejects.toMatchObject({
        details: { reason: 'SCOPE_CHAPTER_NOT_IN_BOOK' },
    });
});
