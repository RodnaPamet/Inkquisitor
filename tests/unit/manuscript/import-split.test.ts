/**
 * An import's split (Phase 5.1, D33): the outline the author sees, the plan proposed first, the plan's checks, the
 * split itself — and its cost, which is linear in the document (counted work, never a clock).
 */
import type { DocBlock } from '@/lib/sources/document';
import { defaultPlan, outlineOf, planProblem, planSummary, splitManuscript, type ImportPlan } from '@/lib/manuscript/import-split';

const h = (level: number, text: string): DocBlock => ({ kind: 'heading', level, text });
const p = (text: string): DocBlock => ({ kind: 'para', text });
const br: DocBlock = { kind: 'break', strength: 'scene' };

const BOOK: DocBlock[] = [
    p('A note before anything.'),
    h(1, 'Part One'),
    h(2, 'Chapter 1'),
    h(3, 'Arrival'),
    p('Wren came ashore at dawn.'),
    br,
    p('By noon the tide had turned.'),
    h(3, 'The quay'),
    p('The harbour master counted barrels.'),
    h(2, 'Chapter 2'),
    p('Rain all week.'),
    h(1, 'Part Two'),
    h(2, 'Chapter 3'),
    h(4, 'A letter'),
    p('Dear Wren, come home.'),
];

describe('the outline and the proposed plan', () => {
    it('lists every heading with its level and words, the levels used and the breaks', () => {
        const o = outlineOf(BOOK);
        expect(o.headings.map((x) => [x.index, x.level, x.text, x.sectionWords])).toEqual([
            [0, 1, 'Part One', 0],
            [1, 2, 'Chapter 1', 0],
            [2, 3, 'Arrival', 11],
            [3, 3, 'The quay', 5],
            [4, 2, 'Chapter 2', 3],
            [5, 1, 'Part Two', 0],
            [6, 2, 'Chapter 3', 0],
            [7, 4, 'A letter', 4],
        ]);
        expect(o.levels).toEqual([1, 2, 3, 4]);
        expect(o.sceneBreaks).toBe(1);
        expect(o.preambleWords).toBe(4);
    });

    it('proposes the outermost three levels as part, chapter, scene; two as chapter, scene; one as chapters', () => {
        expect(defaultPlan(outlineOf(BOOK)).levels).toEqual({ part: 1, chapter: 2, scene: 3 });
        expect(defaultPlan(outlineOf([h(2, 'A'), h(3, 'B')])).levels).toEqual({ part: null, chapter: 2, scene: 3 });
        expect(defaultPlan(outlineOf([h(1, 'A'), p('x')])).levels).toEqual({ part: null, chapter: 1, scene: null });
        expect(defaultPlan(outlineOf([p('only prose')])).levels).toEqual({ part: null, chapter: null, scene: null });
        expect(defaultPlan(outlineOf(BOOK)).sceneBreaks).toBe(true);
    });

    it('refuses a plan that does not fit the outline, by name', () => {
        const o = outlineOf(BOOK);
        const base = defaultPlan(o);
        expect(planProblem(base, o)).toBeNull();
        expect(planProblem({ ...base, levels: { part: 1, chapter: 1, scene: 3 } }, o)).toBe('LEVELS_NOT_DISTINCT');
        expect(planProblem({ ...base, levels: { part: null, chapter: 5, scene: null } }, o)).toBe('LEVEL_UNUSED');
        expect(planProblem({ ...base, overrides: [[99, 'scene']] }, o)).toBe('OVERRIDE_OUT_OF_RANGE');
        expect(planProblem({ ...base, overrides: [[1, 'scene'], [1, 'text']] }, o)).toBe('OVERRIDE_DUPLICATE');
    });
});

describe('the split', () => {
    it('makes parts, chapters and scenes at their headings, a break starting a scene, the preamble untitled', () => {
        const r = splitManuscript(BOOK, defaultPlan(outlineOf(BOOK)));
        const shape = r.parts.map((part) => [part.title, part.chapters.map((c) => [c.title, c.scenes.map((s) => [s.title, s.paragraphs])])]);
        expect(shape).toEqual([
            [null, [[null, [[null, ['A note before anything.']]]]]],
            [
                'Part One',
                [
                    [
                        'Chapter 1',
                        [
                            ['Arrival', ['Wren came ashore at dawn.']],
                            [null, ['By noon the tide had turned.']],
                            ['The quay', ['The harbour master counted barrels.']],
                        ],
                    ],
                    ['Chapter 2', [[null, ['Rain all week.']]]],
                ],
            ],
            ['Part Two', [['Chapter 3', [[null, ['A letter', 'Dear Wren, come home.']]]]]],
        ]);
        expect(r.counts).toEqual({ parts: 3, chapters: 4, scenes: 6, words: 29 });
    });

    it('lets the author override one heading: a scene heading as plain text joins the scene before', () => {
        const plan: ImportPlan = { ...defaultPlan(outlineOf(BOOK)), sceneBreaks: false, overrides: [[3, 'text']] };
        const chapter1 = splitManuscript(BOOK, plan).parts[1].chapters[0];
        expect(chapter1.scenes.map((s) => [s.title, s.paragraphs])).toEqual([['Arrival', ['Wren came ashore at dawn.', 'By noon the tide had turned.', 'The quay', 'The harbour master counted barrels.']]]);
    });

    it('agrees with the browser\'s summary of a plan where no break is placed', () => {
        const o = outlineOf(BOOK);
        const plan: ImportPlan = { ...defaultPlan(o), sceneBreaks: false };
        const s = planSummary(o, plan);
        const r = splitManuscript(BOOK, plan).counts;
        expect([s.parts, s.chapters, s.scenes]).toEqual([r.parts, r.chapters, r.scenes]);
    });

    it('is linear: a 150,000-word manuscript is one visit a block (counted, never timed)', () => {
        const blocks: DocBlock[] = [];
        const sentence = 'The tide came in over the stones and the gulls rose crying into the wind again.'; // 16 words
        for (let c = 1; c <= 60; c++) {
            blocks.push(h(1, `Chapter ${c}`));
            for (let s = 1; s <= 5; s++) {
                blocks.push(h(2, `Scene ${s}`));
                for (let k = 0; k < 32; k++) blocks.push(p(`${sentence} ${sentence}`));
            }
        }
        const o = outlineOf(blocks);
        expect(o.words).toBeGreaterThanOrEqual(150_000);
        const r = splitManuscript(blocks, defaultPlan(o));
        expect(r.work).toBe(blocks.length);
        expect(r.counts).toMatchObject({ parts: 1, chapters: 60, scenes: 300 });
        const half = splitManuscript(blocks.slice(0, blocks.length / 2), defaultPlan(o));
        expect(half.work * 2).toBe(r.work);
    });
});
