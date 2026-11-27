/**
 * The owner's decisions of 2026-11-27 on 5.3 (D35 addendum), the pure parts: the deep check's page with the draft's
 * facts labelled as the manuscript's (A), the pair rule that never pairs two draft facts (A), the evaluation set's
 * draft cases (A). The night's halves (B) and "Recently resolved" (C) are held end to end in
 * `tests/integration/draft-addendum.test.ts`.
 */
import { CONTINUITY_PROMPT, continuityBlocks, factLine } from '@/lib/continuity/prompt';
import { validateContinuityPairs } from '@/lib/continuity/validate';
import { checkContinuityRecord, gradeContinuityCase } from '@/lib/continuity/evals/evaluation';
import { continuityCases } from '@/lib/continuity/evals/eval-set';
import committed from '@/lib/continuity/evals/evaluation-record.json';

const line = (statement: string) => ({ predicate: 'ROLE', subjectName: 'Mara', statement, storyTimeFrom: null, storyTimeTo: null, at: null });

describe('A — the page the deep check is shown', () => {
    it('with no draft facts it is exactly 4.2’s page: one facts block (and the orders), no draft block', () => {
        const facts = [line('Mara keeps the light.'), line('Mara rows to the island.')];
        const blocks = continuityBlocks({ facts, orders: [] });
        expect(blocks).toEqual([{ label: 'facts', text: [factLine(facts[0], 1), factLine(facts[1], 2)].join('\n') }]);
        expect(continuityBlocks({ facts, draftFacts: [], orders: [] })).toEqual(blocks);
    });

    it('draft facts travel in their own block, labelled as the draft, numbered on from the bible’s facts, each naming its scene', () => {
        const blocks = continuityBlocks({ facts: [line('Mara keeps the light.')], draftFacts: [{ ...line('Mara has never climbed the stair.'), sceneTitle: 'The lamp' }, { ...line('Mara mends nets.'), sceneTitle: null }], orders: [] });
        expect(blocks.map((b) => b.label)).toEqual(['facts', 'draft-facts']);
        expect(blocks[1].text).toBe('2. [ROLE] Mara: Mara has never climbed the stair. (scene: The lamp)\n3. [ROLE] Mara: Mara mends nets. (scene: untitled)');
    });

    it('the prompt tells the model the draft facts are the manuscript’s claims, not canon, and never to pair two of them', () => {
        expect(CONTINUITY_PROMPT.system).toMatch(/"draft-facts" block[^\n]*MANUSCRIPT DRAFT[^\n]*NOT the bible's canon[^\n]*never pair two draft facts with each other/);
    });
});

describe('A — a pair of two draft facts is never proposed, whatever the model says', () => {
    it('refuses it DRAFT_PAIR and keeps a draft fact paired with a bible fact', () => {
        const v = validateContinuityPairs(
            { contradictions: [{ first: 1, second: 2, kind: 'OTHER' }, { first: 2, second: 3, kind: 'OTHER' }, { first: 1, second: 3, kind: 'VALUE' }] },
            ['bible', 'draft-a', 'draft-b'],
            { draftIds: new Set(['draft-a', 'draft-b']) },
        );
        expect(v.pairs).toEqual([{ a: 'bible', b: 'draft-a', kind: 'OTHER' }, { a: 'bible', b: 'draft-b', kind: 'VALUE' }]);
        expect(v.refusals).toEqual({ DRAFT_PAIR: 1 });
    });
});

describe('A — the evaluation set holds draft cases and near misses, and the committed record passes them', () => {
    it('has a draft-vs-bible clash of each kind it names, near misses (a synonym, another time, two drafts against each other) and an adversarial draft fact', () => {
        const drafted = continuityCases.filter((c) => c.facts.some((f) => f.draft));
        expect(drafted.map((c) => c.id)).toEqual(['cc-10', 'cc-11', 'cc-12', 'adv-02']);
        const kinds = new Set(drafted.flatMap((c) => c.expect.map((e) => e.kind)));
        expect([...kinds].sort()).toEqual(['KNOWLEDGE', 'VALUE', 'WHEREABOUTS']);
        // A near miss of two DRAFT facts in every draft case that holds two.
        for (const c of drafted.filter((x) => x.facts.filter((f) => f.draft).length >= 2 && x.id !== 'adv-02')) {
            const draft = new Set(c.facts.filter((f) => f.draft).map((f) => f.ref));
            expect([c.id, c.mustNotPair.some(([a, b]) => draft.has(a) && draft.has(b))]).toEqual([c.id, true]);
        }
        const check = checkContinuityRecord(committed);
        expect(check.ok).toBe(true);
    });

    it('a model that pairs two draft facts gains nothing: the product refuses the pair, so the case still passes', () => {
        const c = continuityCases.find((x) => x.id === 'cc-10')!;
        const grade = gradeContinuityCase(c, { contradictions: [{ first: 1, second: 3, kind: 'VALUE' }, { first: 4, second: 5, kind: 'VALUE' }] });
        expect(grade).toMatchObject({ passed: true, proposed: 1, correct: 1, falseAlarms: 0 });
    });
});

