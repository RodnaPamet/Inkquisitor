/**
 * THE QUESTION GENERATORS (Phase 4.4, D23 and D30): the frontier is one
 * generator among several, each candidate carries a code value score, and code
 * validates, deduplicates and orders every candidate, best value first. Pure.
 */
import { getTemplate, relationFieldDefs } from '@/lib/bible/templates';
import { questionOptionsProblem, questionTextProblem } from '@/lib/interview/candidates';
import { dedupe } from '@/lib/interview/dedupe';
import { computeFrontier } from '@/lib/interview/frontier';
import { generateCandidates, ladderDepthFor, ladderKey, type GeneratorInput, type GeneratorSubject, type TargetCandidate } from '@/lib/interview/generators';
import { compareCandidates, PAIRS_PER_ROUND_MAX, selectCandidates, tieGroups } from '@/lib/interview/generators/select';
import { MINOR_VALUE_FLOOR, ladderValue } from '@/lib/interview/generators/value';
import { contradictionQuestion, ladderQuestion, pairQuestion, quoted, SOURCE_NO, SOURCE_YES, sourceQuestion, threadQuestion, timelineGapQuestion } from '@/lib/interview/generators/wording';
import { pairOfSubject, pairSubjectId } from '@/lib/interview/subjects';
import { LADDER_LAYERS, PAIR_ANGLES, QUESTION_GENERATORS, type QuestionGeneratorKey } from '@/lib/interview/vocabulary';

const WREN = 'el-wren';
const IDA = 'el-ida';

function subject(id: string, name: string, kind: 'CHARACTER' | 'FACTION' | 'TIMELINE_EVENT' | 'PLOT', stored: Record<string, string>): GeneratorSubject {
    return { elementId: id, kind, name, fields: getTemplate(kind).fields, storedText: new Map(Object.entries(stored)) };
}

function input(over: Partial<GeneratorInput> & { subjects: GeneratorSubject[] }): GeneratorInput {
    const frontier = computeFrontier({ elements: over.subjects.map((s) => ({ elementId: s.elementId, kind: s.kind, fields: s.fields, storedKeys: new Set(s.storedText.keys()) })), sessionAnswers: [], depth: over.depth ?? 3 });
    return {
        depth: 3,
        detail: 3,
        enabled: new Set(QUESTION_GENERATORS),
        frontier,
        ladder: { answered: new Set(), askedInSession: new Set() },
        factsHeld: new Map(),
        pairs: [],
        pendingFacts: [],
        continuity: [],
        ...over,
    };
}

const subjectsMap = (subjects: GeneratorSubject[], extra: Array<[string, GeneratorSubject['fields']]> = []) =>
    new Map<string, Pick<GeneratorSubject, 'elementId' | 'fields'>>([...subjects.map((s) => [s.elementId, s] as const), ...extra.map(([id, fields]) => [id, { elementId: id, fields }] as const)]);

describe('code wording (the templates are the generators’ evaluation: every one a valid question)', () => {
    it('every ladder layer, pair angle, source, contradiction, thread and gap question holds the question rules', () => {
        const texts = [
            ...LADDER_LAYERS.map((l) => ladderQuestion(l, { kind: 'element', name: 'Wren Holt' }, 'Conscious want')),
            ...LADDER_LAYERS.map((l) => ladderQuestion(l, { kind: 'relation', fromName: 'Wren', toName: 'Ida' }, 'Nature of the link')),
            ...PAIR_ANGLES.map((a) => pairQuestion(a, 'Wren Holt', 'The Harbourmaster')),
            sourceQuestion('Wren never learned to swim.', 'draft-1.docx', 'Chapter 3'),
            contradictionQuestion('Wren', 'She is seventeen that winter.', 'She turned nineteen before the flood.'),
            ...(['PROMISE', 'CLUE', 'OPEN_QUESTION'] as const).map((k) => threadQuestion(k, 'The gun on the wall')),
            timelineGapQuestion('The weir breaks', { name: 'The first frost', time: 'November' }, { name: 'The thaw', time: 'March' }),
        ];
        for (const q of texts) {
            expect(questionTextProblem(q.text)).toBeNull();
            if (q.options) expect(questionOptionsProblem(q.kind, q.options)).toBe(false);
        }
    });

    it('a source question quotes its source verbatim (D23’s own example) and offers exactly yes and no', () => {
        const q = sourceQuestion('Wren never learned to swim', 'my draft', 'ch. 3');
        expect(q.text).toBe('Your source “my draft” says “Wren never learned to swim” (ch. 3). Is that canon?');
        expect(q.kind).toBe('EITHER_OR');
        expect(q.options).toEqual([SOURCE_YES, SOURCE_NO]);
    });

    it('a question mark inside the author’s words stays (full-width), so the question still holds exactly one', () => {
        const q = sourceQuestion('Who drowned? Nobody knows.', 'notes', null);
        expect(q.text).toContain('Who drowned？ Nobody knows.');
        expect(questionTextProblem(q.text)).toBeNull();
        expect(quoted('a?b', 10)).toBe('a？b');
    });

    it('a long quote and long names are cut so the question stays within its bound', () => {
        const long = 'word '.repeat(200);
        for (const q of [sourceQuestion(long, 'x'.repeat(200), 'y'.repeat(200)), contradictionQuestion('n'.repeat(300), long, long), timelineGapQuestion('e'.repeat(300), { name: 'b'.repeat(300), time: 't'.repeat(300) }, { name: 'a'.repeat(300), time: 't'.repeat(300) })]) {
            expect(questionTextProblem(q.text)).toBeNull();
        }
    });

    it('two layers of one field never read as repeats of each other (deduplication would otherwise drop the deeper one)', () => {
        const asked = LADDER_LAYERS.map((l, i) => ({ id: `q${i}`, scope: 'SESSION' as const, elementId: WREN, targetsFieldKeys: ['want'], kind: 'OPEN' as const, text: ladderQuestion(l, { kind: 'element', name: 'Wren Holt' }, 'Conscious want').text, options: null, scaleLabels: null }));
        for (let i = 1; i < asked.length; i++) {
            const result = dedupe({ candidates: [asked[i]], asked: asked.slice(0, i), ctx: { elementNames: new Map([[WREN, 'Wren Holt']]) } });
            expect(result.keptIndexes).toEqual([0]);
        }
    });
});

describe('the frontier as a generator', () => {
    it('proposes every frontier field, model-worded, valued: core above optional', () => {
        const c = generateCandidates(input({ subjects: [subject(WREN, 'Wren', 'CHARACTER', {})] }));
        const frontier = c.filter((x) => x.generator === 'FRONTIER');
        expect(frontier.length).toBeGreaterThan(0);
        expect(frontier.every((x) => x.worded === null)).toBe(true);
        const role = frontier.find((x) => x.fieldKey === 'role')!;
        expect(role.value).toBeGreaterThan(50);
        expect(frontier.find((x) => x.fieldKey === 'prominence')!.value).toBeLessThan(role.value);
    });

    it('never asks what the bible answers (rule 5): a stored field is not a frontier candidate', () => {
        const c = generateCandidates(input({ subjects: [subject(WREN, 'Wren', 'CHARACTER', { role: 'The lock-keeper’s daughter.' })] }));
        expect(c.some((x) => x.generator === 'FRONTIER' && x.fieldKey === 'role')).toBe(false);
    });

    it('switched off, it proposes nothing (the dial)', () => {
        const c = generateCandidates(input({ subjects: [subject(WREN, 'Wren', 'CHARACTER', {})], enabled: new Set<QuestionGeneratorKey>(['LADDER']) }));
        expect(c).toEqual([]);
    });
});

describe('the deepening ladder', () => {
    const answeredWren = () => subject(WREN, 'Wren', 'CHARACTER', { role: 'The lock-keeper’s daughter.', want: 'To keep the lock open.' });

    it('follows up an answered prose field, layer by layer from WHAT, code-worded', () => {
        const c = generateCandidates(input({ subjects: [answeredWren()] })).filter((x) => x.generator === 'LADDER');
        expect(c.map((x) => x.fieldKey).sort()).toEqual(['role', 'want']);
        expect(c.every((x) => x.angle === 'WHAT' && x.worded?.kind === 'OPEN')).toBe(true);
    });

    it('never asks a layer the book already holds, and goes one layer down once the one above is answered', () => {
        const answered = new Set([ladderKey(WREN, 'want', 'WHAT'), ladderKey(WREN, 'want', 'WHY')]);
        const c = generateCandidates(input({ subjects: [answeredWren()], ladder: { answered, askedInSession: new Set() } })).filter((x) => x.generator === 'LADDER' && x.fieldKey === 'want');
        expect(c.map((x) => x.angle)).toEqual(['COST']);
    });

    it('a layer asked in this session (whatever became of it) is not asked again, and the field waits rather than skip ahead', () => {
        const c = generateCandidates(input({ subjects: [answeredWren()], ladder: { answered: new Set(), askedInSession: new Set([ladderKey(WREN, 'want', 'WHAT')]) } }));
        expect(c.some((x) => x.generator === 'LADDER' && x.fieldKey === 'want')).toBe(false);
    });

    it('the depth dial sets how far down it goes (D23): depth 1 reaches two layers, depth 5 all six', () => {
        expect(ladderDepthFor(1)).toBe(2);
        expect(ladderDepthFor(5)).toBe(6);
        const held = new Set([ladderKey(WREN, 'want', 'WHAT'), ladderKey(WREN, 'want', 'WHY')]);
        const shallow = generateCandidates(input({ depth: 1, subjects: [answeredWren()], ladder: { answered: held, askedInSession: new Set() } }));
        expect(shallow.some((x) => x.generator === 'LADDER' && x.fieldKey === 'want')).toBe(false);
    });

    it('follows up prose only, never a choice or a scale, and never at a pick-only detail', () => {
        const s = subject(WREN, 'Wren', 'CHARACTER', { role: 'x', prominence: 'lead', agency: '4' });
        const c = generateCandidates(input({ subjects: [s] })).filter((x) => x.generator === 'LADDER');
        expect(c.map((x) => x.fieldKey)).toEqual(['role']);
        expect(generateCandidates(input({ subjects: [s], detail: 1 })).some((x) => x.generator === 'LADDER')).toBe(false);
    });

    it('each layer adds less, and facts the book already holds about the field lower it', () => {
        const values = LADDER_LAYERS.map((l) => ladderValue(l, { required: false, factsHeld: 0 }));
        expect([...values].sort((a, b) => b - a)).toEqual(values);
        expect(ladderValue('WHAT', { required: false, factsHeld: 2 })).toBeLessThan(ladderValue('WHAT', { required: false, factsHeld: 0 }));
        // The deepest layers are minor: a session asks before going on to them.
        expect(ladderValue('EDGE_CASES', { required: false, factsHeld: 0 })).toBeLessThan(MINOR_VALUE_FLOOR);
    });
});

describe('relations: pairs with no relation yet', () => {
    const pair = (over: Partial<GeneratorInput['pairs'][number]> = {}) => ({ firstElementId: WREN, secondElementId: IDA, firstName: 'Wren', secondName: 'Ida', answered: new Set<never>(), askedInSession: new Set<never>(), ...over });

    it('asks what one wants from the other and where they collide, filed under the pair, landing in the link’s fields', () => {
        const c = generateCandidates(input({ subjects: [], pairs: [pair()] })).filter((x) => x.pairElementId);
        expect(c.map((x) => [x.angle, x.fieldKey])).toEqual([
            ['WANTS', 'nature'],
            ['COLLIDE', 'significance'],
        ]);
        expect(pairOfSubject(c[0].elementId)).toEqual({ firstElementId: WREN, secondElementId: IDA });
        expect(c[0].worded!.text).toBe('What does Wren want from Ida?');
    });

    it('asks what is hidden once what each wants is answered, and never an angle the book holds', () => {
        const c = generateCandidates(input({ subjects: [], pairs: [pair({ answered: new Set(['WANTS', 'COLLIDE'] as const) as never })] })).filter((x) => x.pairElementId);
        expect(c.map((x) => x.angle)).toEqual(['HIDDEN']);
    });

    it('a pair subject id names its two elements and nothing else', () => {
        expect(pairOfSubject(pairSubjectId('a1', 'b2'))).toEqual({ firstElementId: 'a1', secondElementId: 'b2' });
        expect(pairOfSubject('a1')).toBeNull();
        expect(pairOfSubject('pair:a1')).toBeNull();
        expect(pairOfSubject('pair:a1:b2:c3')).toBeNull();
    });
});

describe('source questions and continuity', () => {
    it('a pending fact is a yes-or-no question quoting it; one whose predicate answers no field targets none', () => {
        const s = subject(WREN, 'Wren', 'CHARACTER', {});
        const c = generateCandidates(
            input({
                subjects: [s],
                pendingFacts: [
                    { factId: 'f1', subjectElementId: WREN, fieldKey: 'role', quote: 'Wren keeps the lock.', sourceName: 'draft', where: null },
                    { factId: 'f2', subjectElementId: WREN, fieldKey: null, quote: 'Wren never learned to swim.', sourceName: 'draft', where: 'Chapter 3' },
                ],
            }),
        ).filter((x) => x.generator === 'SOURCES');
        expect(c.map((x) => [x.storyFactId, x.fieldKey])).toEqual([
            ['f1', 'role'],
            ['f2', null],
        ]);
        // An empty field it answers outright is worth more than a frontier question on it.
        const frontierRole = generateCandidates(input({ subjects: [s] })).find((x) => x.generator === 'FRONTIER' && x.fieldKey === 'role')!;
        expect(c[0].value).toBeGreaterThan(frontierRole.value);
    });

    it('a SERIES source’s fact says it is one, and that the answer applies across the series (owner decision 2026-11-26, B)', () => {
        const s = subject(WREN, 'Wren', 'CHARACTER', {});
        const [own, series] = generateCandidates(
            input({
                subjects: [s],
                pendingFacts: [
                    { factId: 'f1', subjectElementId: WREN, fieldKey: 'role', quote: 'Wren keeps the lock.', sourceName: 'draft', where: null },
                    { factId: 'f2', subjectElementId: WREN, fieldKey: 'want', quote: 'Wren wants the sea.', sourceName: 'book one', where: null, series: true },
                ],
            }),
        ).filter((x) => x.generator === 'SOURCES');
        expect(own.angle).toBeUndefined();
        expect(own.worded!.text).toBe('Your source “draft” says “Wren keeps the lock.”. Is that canon?');
        expect(series.angle).toBe('SERIES');
        expect(series.worded!.text).toBe('Your series source “book one” says “Wren wants the sea.”. Is that canon for every book in the series?');
        expect(series.worded!.options).toEqual([SOURCE_YES, SOURCE_NO]);
        expect(questionTextProblem(series.worded!.text)).toBeNull();
        // A long series quote is cut so the longer frame still fits.
        expect(questionTextProblem(sourceQuestion('word '.repeat(200), 'x'.repeat(200), 'y'.repeat(200), true).text)).toBeNull();
    });

    it('a contradiction, an open thread and a timeline gap each become a question landing in a field', () => {
        const wren = subject(WREN, 'Wren', 'CHARACTER', { role: 'x' });
        const plot = subject('el-plot', 'The flood', 'PLOT', {});
        const event = subject('el-ev', 'The weir breaks', 'TIMELINE_EVENT', {});
        const c = generateCandidates(
            input({
                subjects: [wren, plot, event],
                continuity: [
                    { type: 'CONTRADICTION', proposalId: 'p1', subjectElementId: WREN, fieldKey: 'role', olderQuote: 'She keeps the lock.', newerQuote: 'She left the lock years ago.' },
                    { type: 'THREAD', threadId: 't1', threadKind: 'PROMISE', subjectElementId: 'el-plot', fieldKey: 'setups_and_payoffs', title: 'The gun on the wall' },
                    { type: 'TIMELINE_GAP', elementId: 'el-ev', fieldKey: 'story_time', before: { name: 'Frost', time: 'November' }, after: { name: 'Thaw', time: 'March' } },
                ],
            }),
        ).filter((x) => x.generator === 'CONTINUITY');
        expect(c.map((x) => x.continuityRef)).toEqual(['proposal:p1', 'thread:t1', 'gap:el-ev']);
        expect(c.every((x) => x.fieldKey !== null)).toBe(true);
    });
});

describe('selection: code validates, deduplicates and orders every candidate, best value first (D30 item 1)', () => {
    const wren = subject(WREN, 'Wren', 'CHARACTER', {});
    const cand = (over: Partial<TargetCandidate>): TargetCandidate => ({ generator: 'FRONTIER', elementId: WREN, fieldKey: 'role', level: 1, required: true, value: 50, worded: null, ...over });

    it('orders across generators by value, then generator, then the order proposed', () => {
        const s = selectCandidates(
            [cand({ fieldKey: 'role', value: 60 }), cand({ generator: 'SOURCES', fieldKey: 'want', value: 80, worded: sourceQuestion('q', 'd', null), storyFactId: 'f' }), cand({ fieldKey: 'wound', value: 60 })],
            { cap: 10, subjects: subjectsMap([wren]) },
        );
        expect(s.chosen.map((c) => c.fieldKey)).toEqual(['want', 'role', 'wound']);
    });

    it('one candidate per field a round, whichever generators proposed it: the higher value wins', () => {
        const s = selectCandidates([cand({ fieldKey: 'want', value: 70 }), cand({ generator: 'SOURCES', fieldKey: 'want', value: 80, worded: sourceQuestion('q', 'd', null), storyFactId: 'f' })], { cap: 10, subjects: subjectsMap([wren]) });
        expect(s.chosen.map((c) => c.generator)).toEqual(['SOURCES']);
        expect(s.duplicates).toBe(1);
    });

    it('refuses by name a candidate about an unknown subject or field, a bad value or a bad code-worded text', () => {
        const s = selectCandidates(
            [cand({ elementId: 'nobody' }), cand({ fieldKey: 'no_such_field' }), cand({ value: 101 }), cand({ generator: 'LADDER', fieldKey: 'want', worded: { kind: 'OPEN', text: 'Two? Questions?', options: null } }), cand({ generator: 'LADDER', fieldKey: 'want', worded: null })],
            { cap: 10, subjects: subjectsMap([wren]) },
        );
        expect(s.chosen).toEqual([]);
        expect(s.refused).toEqual({ UNKNOWN_SUBJECT: 1, UNKNOWN_FIELD: 1, BAD_VALUE: 1, BAD_TEXT: 2 });
    });

    it('asks only what is above the floor, and says the value fell — never pads — when only minor candidates are left', () => {
        const minor = [cand({ generator: 'LADDER', fieldKey: 'want', value: 20, worded: ladderQuestion('BREAKS', { kind: 'element', name: 'Wren' }, 'Want') })];
        const s = selectCandidates(minor, { cap: 10, subjects: subjectsMap([wren]) });
        expect(s).toMatchObject({ chosen: [], valueFell: true, minor: 1 });
        // Once the author chose to go on, the floor is 0.
        expect(selectCandidates(minor, { cap: 10, floor: 0, subjects: subjectsMap([wren]) }).chosen).toHaveLength(1);
        // Nothing at all is not a value fall: the frontier's own stop says why.
        expect(selectCandidates([], { cap: 10, subjects: subjectsMap([wren]) }).valueFell).toBe(false);
    });

    it('HOLDS a field with a pending proposed change (owner decision 2026-11-26, A): no generator asks about it, counted, until the author decides', () => {
        const answered = subject(WREN, 'Wren', 'CHARACTER', { want: 'To keep the lock open.' });
        const pairFields = relationFieldDefs('CHARACTER', 'related_to');
        const pair = { firstElementId: WREN, secondElementId: IDA, firstName: 'Wren', secondName: 'Ida', answered: new Set<never>(), askedInSession: new Set<never>() };
        const all = generateCandidates(input({ subjects: [answered], pairs: [pair] }));
        const subjects = subjectsMap([answered], [[pairSubjectId(WREN, IDA), pairFields]]);
        const free = selectCandidates(all, { cap: 20, subjects });
        expect(free.chosen.some((c) => c.generator === 'LADDER' && c.fieldKey === 'want')).toBe(true);
        expect(free.chosen.some((c) => c.generator === 'FRONTIER' && c.fieldKey === 'role')).toBe(true);
        expect(free.chosen.some((c) => c.pairElementId === IDA)).toBe(true);
        expect(free.held).toBe(0);
        // A pending change to Wren's want (the ladder's field), to her role (the frontier's) and a new relation pending
        // between Wren and Ida (both of the pair's fields): none is asked, each counted as held.
        const held = new Set([`${WREN}\u0000want`, `${WREN}\u0000role`, `${pairSubjectId(WREN, IDA)}\u0000nature`, `${pairSubjectId(WREN, IDA)}\u0000significance`]);
        const waiting = selectCandidates(all, { cap: 20, subjects, held });
        expect(waiting.chosen.some((c) => c.fieldKey === 'want' || c.fieldKey === 'role' || c.pairElementId === IDA)).toBe(false);
        expect(waiting.held).toBe(4);
        expect(waiting.chosen.length).toBe(free.chosen.length - 4);
        // A source question deciding a fact with no field is never held: it fills no field.
        const fact = cand({ generator: 'SOURCES', fieldKey: null, value: 90, worded: sourceQuestion('q', 'd', null), storyFactId: 'f' });
        expect(selectCandidates([fact], { cap: 5, subjects: subjectsMap([wren]), held }).chosen).toHaveLength(1);
    });

    it('cuts to the round’s room and at most a small number of pairs a round', () => {
        const pairId = (i: number) => pairSubjectId(`a${i}`, `b${i}`);
        const pairs = [0, 1, 2, 3].map((i) => cand({ generator: 'RELATIONS', elementId: pairId(i), fieldKey: 'nature', value: 50, pairElementId: `b${i}`, angle: 'WANTS', worded: pairQuestion('WANTS', 'A', 'B') }));
        const s = selectCandidates([...pairs, cand({ fieldKey: 'role', value: 40 })], { cap: 10, subjects: subjectsMap([wren], [0, 1, 2, 3].map((i) => [pairId(i), relationFieldDefs('CHARACTER', 'related_to')])) });
        expect(s.chosen.filter((c) => c.pairElementId)).toHaveLength(PAIRS_PER_ROUND_MAX);
        expect(selectCandidates([cand({ fieldKey: 'role' }), cand({ fieldKey: 'want' })], { cap: 1, subjects: subjectsMap([wren]) }).chosen).toHaveLength(1);
    });

    it('compares deterministically', () => {
        const a = { c: cand({ value: 50, generator: 'LADDER' }), i: 0 };
        const b = { c: cand({ value: 50, generator: 'SOURCES' }), i: 1 };
        expect(compareCandidates(a, b)).toBeGreaterThan(0);
    });
});

describe('tie groups: only near-equal candidates may be reordered by the model (D30 item 4)', () => {
    it('finds runs within the band, each at least two long', () => {
        expect(tieGroups([90, 88, 70, 69, 68, 40].map((value) => ({ value })))).toEqual([
            [0, 1],
            [2, 3, 4],
        ]);
        expect(tieGroups([90, 70, 50].map((value) => ({ value })))).toEqual([]);
    });
});
