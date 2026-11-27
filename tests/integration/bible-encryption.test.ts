/**
 * The bible's author text is encrypted at rest (Phase 1.1, roadmap rule 4),
 * and so is the interview's (Phase 2.2: questions generated from it, and the
 * author's answers).
 *
 * For EVERY column of the shipped manifest (`ENCRYPTED_FIELDS`, so a column
 * added there is covered here the day it is added): the value written through
 * the usecases is a `v2:` envelope in the database with no trace of the
 * plaintext, and reads back as the plaintext in its own workspace. The
 * snapshot — a JSON document — is sealed whole as one string and round-trips
 * to the same structure. A ciphertext read under another workspace's key is
 * refused loudly. The readable columns (title, name, slug) stay readable.
 */
import { prisma } from '@/lib/db';
import { runWithDbContext } from '@/lib/db/db-context';
import { DecryptIntegrityError } from '@/lib/db/encryption-middleware';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { createElement, getElement } from '@/app-layer/usecases/bible-elements';
import { addRelation, saveRelationFields } from '@/app-layer/usecases/bible-relations';
import { getVersion } from '@/app-layer/usecases/bible-versions';
import { createBook, getBook } from '@/app-layer/usecases/books';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { getInterview, startInterview } from '@/app-layer/usecases/interviews';
import { closeRoundAndReconcile } from '@/app-layer/usecases/enrichment-reconcile';
import { getSessionReview } from '@/app-layer/usecases/enrichment-review';
import type { GeneratedQuestion } from '@/lib/interview/candidates';
import { allowedTargets, fakeGenerator, fakeQuestion, kindsInPrompt } from '../helpers/fake-question-generator';
import { stubQuestionEmbedder } from '../helpers/interview';
import { scripted } from '../helpers/enrichment';
import { createAccount, workspaceCtx } from '../helpers/workspaces';
import { attachResearchSource, createResearchBrief, dispatchResearchRun } from '@/app-layer/usecases/research-briefs';
import { executeResearchRun } from '@/app-layer/usecases/research-run';
import { saveStoryMap } from '@/app-layer/usecases/story-maps';
import type { Researcher } from '@/lib/research/researcher';
import { CLEAN_SCAN, MOUNTED_GATE } from '../helpers/research';
import { dispatchIngestion, setSeriesOptIn, uploadSource } from '@/app-layer/usecases/source-library';
import { executeSourceIngest } from '@/app-layer/usecases/source-ingest';
import { decideFact, listBookFacts, setFactOverride } from '@/app-layer/usecases/source-facts';
import { defaultFactExtractor } from '@/lib/sources/model-seam';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { fakeAnthropic } from '../helpers/fake-anthropic';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { createThread } from '@/app-layer/usecases/continuity';
import { extractPending } from '../helpers/facts';
import { threadExtractor } from '../helpers/continuity';
import { getGapHuntPage, runGapHunt } from '@/app-layer/usecases/gap-hunts';
import { getStressTest } from '@/app-layer/usecases/stress-tests';
import { InterviewCompactionRepository } from '@/app-layer/repositories/interrogation.repository';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { sanitiseSummaryForStorage } from '@/lib/interview/compaction-prompt';
import { MOUNTED, runStressTest, scriptedTester } from '../helpers/interrogation';
import { seedManuscript } from '../helpers/manuscript';

afterAll(() => prisma.$disconnect());

// Built at run time, so no literal here reads as the stored value.
const MARK = ['quill', 'mark', Date.now().toString(36)].join('-');

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
let ctx: ReturnType<typeof workspaceCtx>;
const ids: Record<string, string> = {};

beforeAll(async () => {
    a = await createAccount();
    b = await createAccount();
    ctx = workspaceCtx(a);
    const book = await createBook(ctx, { title: 'Plain title', logline: `logline ${MARK}` });
    const el = await createElement(ctx, book.id, {
        kind: 'CHARACTER',
        name: 'Plain name',
        summary: `summary ${MARK}`,
        fields: [
            { key: 'want', value: `want ${MARK}` },
            { key: 'defining_traits', value: [`trait ${MARK}`] },
            { key: 'wound', value: `<p>wound ${MARK}</p>` },
        ],
        changeSummary: `change ${MARK}`,
    });
    const other = await createElement(ctx, book.id, { kind: 'FACTION', name: 'Plain faction' });
    const rel = await addRelation(ctx, book.id, { fromElementId: el.id, toElementId: other.id, type: 'member_of', note: `note ${MARK}` });
    // Phase 3.3 (D24): a relation's field, and the version that records it.
    await saveRelationFields(ctx, book.id, rel.id, { baseVersion: 1, fields: [{ key: 'terms', value: `terms ${MARK}` }], changeSummary: `relation change ${MARK}` });
    Object.assign(ids, { Book: book.id, BibleElement: el.id, BibleRelation: rel.id });

    // An interview whose questions carry the mark in every encrypted column (a pick with
    // options and a recommendation, a scale with anchors, a challenge quoting the stored
    // role), and an answer carrying it in its choice and its reason.
    const subject = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Interviewed', fields: [{ key: 'role', value: `A ${MARK} paramedic in a coastal town` }] });
    const marked = (q: GeneratedQuestion): GeneratedQuestion => {
        const key = q.targetsFieldKeys[0];
        if (key === 'want') return { ...q, kind: 'CHOICE', text: `Which ${MARK} way?`, options: [`opt ${MARK} one`, 'opt two', 'opt three'], recommendedAnswer: `opt ${MARK} one`, rationale: `why ${MARK}` };
        if (key === 'wound') return { ...q, kind: 'SCALE', text: 'How raw is it?', scaleLabels: { low: `low ${MARK}`, high: 'high' } };
        return q;
    };
    const generator = fakeGenerator({
        raw: (request) => ({
            questions: allowedTargets(request).flatMap((t) => [
                ...t.allowed_targets.map((k) => marked(fakeQuestion(t.elementId, k, kindsInPrompt(request)))),
                ...(t.may_challenge === 'role'
                    ? [{ ...fakeQuestion(t.elementId, 'role', ['OPEN']), mode: 'CHALLENGE' as const, challengeQuote: `${MARK} paramedic in a`, text: `You wrote ${MARK} paramedic in a: what does it cost?` }]
                    : []),
            ]),
            declined: [],
        }),
    });
    const interview = await startInterview(ctx, book.id, { scope: 'ELEMENT', elementId: subject.id, depth: 4, detail: 3 }, { generator, embedder: stubQuestionEmbedder });
    const pick = interview.round!.questions.find((q) => q.kind === 'CHOICE' && q.targetsFieldKeys[0] === 'want')!;
    await answerQuestion(ctx, book.id, interview.session.id, pick.id, { choice: `opt ${MARK} one`, text: `reason ${MARK}` });
    Object.assign(ids, { Session: interview.session.id });

    // Enrichment (Phase 2.5): the round closed and reconciled into a field
    // proposal and a new-element proposal whose value, name and summary carry
    // the mark (each drawn from the marked answer, so each passes validation).
    const reconciler = scripted((f) => {
        const a = f.answers.find((x) => x.status === 'ANSWERED')!;
        return {
            operations: [{ elementId: f.elements[0].elementId, fieldKey: 'want', op: 'ADD', value: `reason ${MARK}`, cites: [a.answerId] }],
            newElements: [{ kind: 'CHARACTER', name: `Opt ${MARK}`, summary: `reason ${MARK}`, fillsSlot: false, cites: [a.answerId] }],
        };
    });
    const closed = await closeRoundAndReconcile(ctx, book.id, interview.session.id, String(interview.round!.number), { skipUnanswered: true }, { reconciler });
    expect(closed.reconcile?.proposed).toMatchObject({ ADD: 1, NEW_ELEMENT: 1 });

    // Research (Phase 2.6): a brief, an attached file, a fetched page, findings
    // citing both (one with no fit), an ADD and a new element, each carrying the
    // mark. The researcher is scripted: what it returns still passes the run's
    // validation, so every row below was written by the product's own path.
    const falconer = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Falconer' });
    const pageUrl = `https://research.example/${MARK}`;
    const page = [`Falconers say the falcon ${MARK} rests calmly on the fist for hours.`, `The Hawking Guild ${MARK} trained hawks with patience and food rewards.`].join(' ');
    const fileText = `Field notes say the falcon ${MARK} stays quiet in the dark mews.`;
    const cost = { tokensUsed: 10, costMicroUsd: 1, callIds: [] as string[] };
    const researcher: Researcher = {
        gather: async (request) => {
            // The tool uses go through the run's tripwire, as the stream delivers them: each is listed (D15).
            if (request.inspectToolUse({ tool: 'web_search', input: { query: `falcon ${MARK} hooding` } })) throw new Error('the query was refused');
            if (request.inspectToolUse({ tool: 'web_fetch', input: { url: pageUrl } })) throw new Error('the URL was refused');
            return { ok: true, output: { ...cost, stop: 'END_TURN', searches: [], requests: 1, fetches: [{ url: pageUrl, title: `Title ${MARK}`, text: page, retrievedAt: null, errorCode: null }] } };
        },
        findings: async () => ({
            ok: true,
            ...cost,
            output: {
                findings: [
                    { claim: `The falcon ${MARK} rests calmly on the fist for hours.`, summary: `Falconers say the falcon ${MARK} rests calmly on the fist.`, confidence: 'HIGH', citations: [{ ref: 'web.1', quote: `the falcon ${MARK} rests calmly on the fist for hours` }] },
                    { claim: `The Hawking Guild ${MARK} trained hawks with patience.`, summary: `The Hawking Guild ${MARK} trained hawks with food rewards.`, confidence: 'MEDIUM', citations: [{ ref: 'web.1', quote: `The Hawking Guild ${MARK} trained hawks with patience` }] },
                    { claim: `The falcon ${MARK} stays quiet in the dark mews.`, summary: `Field notes say the falcon ${MARK} stays quiet.`, confidence: 'LOW', citations: [{ ref: 'file.1', quote: `the falcon ${MARK} stays quiet in the dark mews` }] },
                ],
            },
        }),
        fit: async () => ({
            ok: true,
            ...cost,
            output: {
                proposals: [
                    { op: 'ADD', elementId: falconer.id, fieldKey: 'want', value: `The falcon ${MARK} rests calmly on the fist.`, newKind: null, newName: null, newSummary: null, rationale: `The falcon ${MARK} rests calmly on the fist, the finding says.`, cites: ['f1'] },
                    { op: 'NEW_ELEMENT', elementId: null, fieldKey: null, value: null, newKind: 'FACTION', newName: `Hawking Guild ${MARK}`, newSummary: `The Hawking Guild ${MARK} trained hawks with patience.`, rationale: `The Hawking Guild ${MARK} trained hawks, the finding says.`, cites: ['f2'] },
                ],
                noFit: [{ finding: 'f3', reason: `The mews of the falcon ${MARK} is not in scope.` }],
            },
        }),
    };
    const brief = await createResearchBrief(ctx, book.id, { question: `How does a falcon ${MARK} rest when hooded?`, purpose: `The hawks ${MARK} must ring true.`, scopeElementIds: [falconer.id], urls: [pageUrl], depth: 'QUICK' });
    await attachResearchSource(ctx, book.id, brief.id, { bytes: new TextEncoder().encode(fileText), mediaType: 'text/plain', filename: `notes-${MARK}.txt` }, { scan: CLEAN_SCAN });
    const undoKey = setFakeApiKey();
    const { runId, ran } = await (async () => {
        const { runId } = await dispatchResearchRun(ctx, book.id, brief.id, { gate: MOUNTED_GATE, enqueue: async () => undefined });
        return { runId, ran: await executeResearchRun({ workspaceId: ctx.workspaceId, runId }, { gate: MOUNTED_GATE, researcher: () => researcher }) };
    })().finally(undoKey);
    expect(ran).toMatchObject({ outcome: 'OK' });
    expect(await prisma.researchProposal.count({ where: { runId } })).toBe(2);
    expect(await prisma.researchFinding.count({ where: { runId, noFitReason: { not: null } } })).toBe(1);
    expect(await prisma.researchEgress.count({ where: { runId } })).toBe(2);
    Object.assign(ids, { ResearchBrief: brief.id, Run: runId });

    // A story map with a sticky note (Phase 3.1): the map's freeform layer and its save's snapshot.
    await saveStoryMap(ctx, book.id, 'relationship', {
        expectedVersion: 0,
        nodes: [{ elementId: falconer.id, x: 0, y: 0, w: 220, h: 88, lane: null }],
        edges: [],
        freeform: [{ id: 'shape:mark-note', typeName: 'shape', type: 'note', x: 0, y: 0, props: { text: `The hood ${MARK} goes on at dusk.` } }],
    });
    const map = await prisma.storyMap.findFirstOrThrow({ where: { bookId: book.id, kind: 'RELATIONSHIP' }, select: { id: true } });
    Object.assign(ids, { StoryMap: map.id });

    // The source library (Phase 4.0): a series source whose name, heading and passage carry the mark, a fact
    // drawn from it with every text field marked, confirmed, and the book's override of it.
    const sentence = `Falconer ${MARK} wants the hawk ${MARK} trained by spring.`;
    const series = await uploadSource(ctx, { kind: 'series' }, { bytes: new TextEncoder().encode(`Chapter ${MARK}\n\n${sentence}`), filename: `book-one-${MARK}.txt` }, { scan: CLEAN_SCAN });
    const extraction = fakeAnthropic([
        { kind: 'text', text: JSON.stringify({ facts: [{ subject: 'Falconer', predicate: 'WANT', object: `the hawk ${MARK}`, statement: sentence, quote: sentence, storyTimeFrom: `winter ${MARK}`, storyTimeTo: `spring ${MARK}` }] }) },
    ]);
    const undoFakeKey = setFakeApiKey();
    try {
        await dispatchIngestion(ctx, series.id, { confirmWorstCaseMicroUsd: series.worstCaseMicroUsd }, { enqueue: async () => undefined });
        expect((await executeSourceIngest({ workspaceId: ctx.workspaceId, sourceId: series.id }, { extractor: (c) => defaultFactExtractor(c, { fetch: extraction.fetch }), embedder: () => new StubEmbeddingProvider() })).outcome).toBe('OK');
    } finally {
        undoFakeKey();
    }
    await setSeriesOptIn(ctx, book.id, series.id, true);
    const fact = (await listBookFacts(ctx, book.id)).facts[0];
    await decideFact(ctx, fact.id, 'CONFIRM');
    await setFactOverride(ctx, book.id, fact.id, { text: `Our own ${MARK} answer.` });
    Object.assign(ids, { Source: series.id, Book: book.id });

    // Continuity (Phase 4.2, D28): a thread by hand, title and note marked, and one proposed from a saved entry.
    await createThread(ctx, book.id, { kind: 'CLUE', title: `A wet boot ${MARK}`, note: `Planted ${MARK} early.` });
    const vow = `Mara swears to find the hawk ${MARK} before spring.`;
    await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Mara', summary: vow });
    await extractPending(ctx, book.id, threadExtractor(vow, `Mara will find the hawk ${MARK}`));
    expect(await prisma.storyThreadProposal.count({ where: { bookId: book.id } })).toBe(1);

    // Book-level interrogation (Phase 4.3, D29): a weak point, a ranked gap hunt's reason and a rounds summary, each marked.
    const stress = await runStressTest(ctx, book.id, { tester: scriptedTester({ weakPoints: [{ kind: 'OTHER', title: `A thin place ${MARK}`, questions: [`What does the ${MARK} cost her?`], cites: ['E1'] }] }) });
    expect(stress.outcome).toBe('OK');
    expect((await getStressTest(ctx, book.id, stress.id)).weakPoints).toHaveLength(1);
    ids.StressTest = stress.id;
    const undo = setFakeApiKey();
    try {
        const gapPage = await getGapHuntPage(ctx, book.id, { gate: MOUNTED });
        if (!gapPage.ranking.available) throw new Error(`the gap hunt cannot rank: ${gapPage.ranking.reason}`);
        const first = gapPage.hunt.candidates[0];
        const hunt = await runGapHunt(ctx, book.id, { confirmWorstCaseMicroUsd: gapPage.ranking.worstMicroUsd }, { gate: MOUNTED, charge: () => undefined, ranker: scriptedTester({ picks: [{ candidate: first.n, reason: `The ${first.fieldLabel.toLowerCase()} holds up the ${MARK} most.`, cites: [first.n] }] }) });
        expect(hunt.ranked).toBe(true);
    } finally {
        undo();
    }
    // The manuscript (Phase 5.1): every encrypted column of its tables, marked.
    const manuscript = await seedManuscript(ctx, book.id, MARK);
    ids.ManuscriptPart = manuscript.partId;
    ids.ManuscriptChapter = manuscript.chapterId;
    ids.ManuscriptScene = manuscript.sceneId;
    await runInWorkspaceContext(ctx, (db) =>
        InterviewCompactionRepository.create(db, ctx.workspaceId, { sessionId: ids.Session, throughRound: 1, summary: sanitiseSummaryForStorage(`Round one asked about the ${MARK} want.`), promptVersion: 'rounds-summary.4.3.0', tokensUsed: 1, costMicroUsd: 1 }),
    );
}, 90_000);

/** The raw stored values of `field` on every row of `model` this suite wrote, read as the owner. */
async function rawValues(model: string, field: string): Promise<string[]> {
    const byElement = model === 'BibleField' || model === 'BibleEntryVersion';
    const bySession = model === 'Question' || model === 'Answer' || model === 'EnrichmentProposal';
    const byRun = model === 'ResearchFinding' || model === 'ResearchCitation' || model === 'ResearchProposal' || model === 'ResearchEgress';
    const byBrief = model === 'ResearchSource';
    const byMap = model === 'MapSnapshot';
    const byRelation = model === 'BibleRelationField' || model === 'BibleRelationVersion';
    const bySource = model === 'SourceChunk' || model === 'StoryFact';
    const byBook = model === 'StoryFactOverride' || model === 'StoryThread' || model === 'StoryThreadProposal' || model === 'GapHunt';
    if (model === 'SceneVersion' || model === 'SceneNoteVersion') {
        const rows = await prisma.$queryRawUnsafe<Array<{ v: string | null }>>(`SELECT "${field}" AS v FROM "${model}" WHERE "sceneId" = $1`, ids.ManuscriptScene);
        return rows.map((r) => r.v).filter((v): v is string => v !== null);
    }
    if (model === 'StressWeakPoint' || model === 'InterviewCompaction') {
        const col = model === 'StressWeakPoint' ? 'stressTestId' : 'sessionId';
        const rows = await prisma.$queryRawUnsafe<Array<{ v: string | null }>>(`SELECT "${field}" AS v FROM "${model}" WHERE "${col}" = $1`, model === 'StressWeakPoint' ? ids.StressTest : ids.Session);
        return rows.map((r) => r.v).filter((v): v is string => v !== null);
    }
    const where = byElement ? `"elementId" = $1` : bySession ? `"sessionId" = $1` : byRun ? `"runId" = $1` : byBrief ? `"briefId" = $1` : byMap ? `"mapId" = $1` : byRelation ? `"relationId" = $1` : bySource ? `"sourceId" = $1` : byBook ? `"bookId" = $1` : `"id" = $1`;
    const id = byElement ? ids.BibleElement : bySession ? ids.Session : byRun ? ids.Run : byBrief ? ids.ResearchBrief : byMap ? ids.StoryMap : byRelation ? ids.BibleRelation : bySource ? ids.Source : byBook ? ids.Book : ids[model];
    const rows = await prisma.$queryRawUnsafe<Array<{ v: string | null }>>(`SELECT "${field}" AS v FROM "${model}" WHERE ${where}`, id);
    return rows.map((r) => r.v).filter((v): v is string => v !== null);
}

const manifest = Object.entries(ENCRYPTED_FIELDS).flatMap(([model, fields]) => fields.map((field) => [model, field] as const));

it('the manifest covers the bible, interview, research, interrogation and manuscript author text the briefs name', () => {
    expect(manifest.map(([m, f]) => `${m}.${f}`).sort()).toEqual(
        [
            'BibleElement.summary',
            'BibleEntryVersion.changeSummary',
            'BibleEntryVersion.snapshot',
            'BibleField.value',
            'BibleRelation.note',
            'BibleRelationField.value',
            'BibleRelationVersion.changeSummary',
            'BibleRelationVersion.snapshot',
            'Book.logline',
            'Question.text',
            'Question.options',
            'Question.scaleLabels',
            'Question.recommendedAnswer',
            'Question.rationale',
            'Question.challengeQuote',
            'Answer.text',
            'Answer.choice',
            'EnrichmentProposal.proposedValue',
            'EnrichmentProposal.newName',
            'EnrichmentProposal.newSummary',
            'ResearchBrief.question',
            'ResearchBrief.purpose',
            'ResearchBrief.sourceUrls',
            'ResearchSource.filename',
            'ResearchSource.text',
            'ResearchFinding.claim',
            'ResearchFinding.summary',
            'ResearchFinding.noFitReason',
            'ResearchCitation.url',
            'ResearchCitation.title',
            'ResearchCitation.quotedSpan',
            'ResearchProposal.proposedValue',
            'ResearchProposal.newName',
            'ResearchProposal.newSummary',
            'ResearchProposal.rationale',
            'ResearchEgress.text',
            'StoryMap.freeformJson',
            'MapSnapshot.snapshot',
            'Source.filename',
            'SourceChunk.text',
            'SourceChunk.headingPath',
            'StoryFact.subjectName',
            'StoryFact.objectLiteral',
            'StoryFact.statement',
            'StoryFact.quote',
            'StoryFact.storyTimeFrom',
            'StoryFact.storyTimeTo',
            'StoryFactOverride.text',
            'StoryThread.title',
            'StoryThread.note',
            'StoryThreadProposal.title',
            'StoryThreadProposal.quote',
            'StressWeakPoint.title',
            'StressWeakPoint.questions',
            'GapHunt.picks',
            'InterviewCompaction.summary',
            'ManuscriptPart.title',
            'ManuscriptChapter.title',
            'ManuscriptScene.title',
            'ManuscriptScene.text',
            'ManuscriptScene.storyTime',
            'ManuscriptScene.note',
            'SceneVersion.text',
            'SceneNoteVersion.note',
        ].sort(),
    );
});

it.each(manifest)('%s.%s is a v2 envelope at rest with no trace of the plaintext', async (model, field) => {
    const values = await rawValues(model, field);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
        expect(v).toMatch(/^v2:/);
        expect(v).not.toContain(MARK);
    }
});

it('the interview reads back as plaintext in its own workspace', async () => {
    const view = await getInterview(ctx, ids.Book, ids.Session);
    const questions = view.round!.questions;
    expect(questions.find((q) => q.kind === 'CHOICE')).toMatchObject({ options: [`opt ${MARK} one`, 'opt two', 'opt three'], recommendedAnswer: `opt ${MARK} one`, rationale: `why ${MARK}` });
    expect(questions.find((q) => q.kind === 'SCALE')?.scaleLabels).toEqual({ low: `low ${MARK}`, high: 'high' });
    expect(questions.find((q) => q.mode === 'CHALLENGE')?.challengeQuote).toBe(`${MARK} paramedic in a`);
    expect(questions.find((q) => q.kind === 'CHOICE')?.answer).toMatchObject({ choice: `opt ${MARK} one`, text: `reason ${MARK}` });
});

it('the proposals read back as plaintext in their own workspace (Phase 2.5)', async () => {
    const review = await getSessionReview(ctx, ids.Book, ids.Session);
    expect(review.fields[0].proposedValue).toBe(`reason ${MARK}`);
    expect(review.newElements[0]).toMatchObject({ name: `Opt ${MARK}`, summary: `reason ${MARK}` });
});

it('reads back as plaintext in its own workspace', async () => {
    expect((await getBook(ctx, ids.Book)).logline).toBe(`logline ${MARK}`);
    const el = await getElement(ctx, ids.Book, ids.BibleElement);
    expect(el.summary).toBe(`summary ${MARK}`);
    expect(el.fields.find((f) => f.key === 'want')?.value).toBe(`want ${MARK}`);
    expect(el.fields.find((f) => f.key === 'defining_traits')?.value).toEqual([`trait ${MARK}`]);
    expect(el.relations[0].note).toBe(`note ${MARK}`);
});

it('the snapshot is sealed whole and round-trips to the same structure', async () => {
    const v1 = await getVersion(ctx, ids.Book, ids.BibleElement, 1);
    expect(v1.changeSummary).toBe(`change ${MARK}`);
    expect(v1.snapshot.element.summary).toBe(`summary ${MARK}`);
    expect(v1.snapshot.fields).toEqual([
        { key: 'defining_traits', order: 3, value: [`trait ${MARK}`] },
        { key: 'want', order: 6, value: `want ${MARK}` },
        { key: 'wound', order: 9, value: `<p>wound ${MARK}</p>` },
    ]);
});

it("another workspace's key refuses the ciphertext loudly", async () => {
    await expect(
        runWithDbContext({ workspaceId: b.workspaceId, source: 'test' }, () => prisma.bibleField.findFirst({ where: { elementId: ids.BibleElement } })),
    ).rejects.toBeInstanceOf(DecryptIntegrityError);
});

it('titles, names and slugs stay readable (they are sorted and keyed on)', async () => {
    const [book] = await prisma.$queryRaw<Array<{ title: string }>>`SELECT "title" FROM "Book" WHERE "id" = ${ids.Book}`;
    const [el] = await prisma.$queryRaw<Array<{ name: string; slug: string }>>`SELECT "name", "slug" FROM "BibleElement" WHERE "id" = ${ids.BibleElement}`;
    expect(book.title).toBe('Plain title');
    expect(el).toEqual({ name: 'Plain name', slug: 'plain-name' });
});
