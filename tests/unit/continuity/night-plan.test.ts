/**
 * One night's page of a book (Phase 4.2, D28): bounded calls, a stable order, a
 * cursor that resumes, an oversized subject cut to its newest facts, and the
 * per-call budget held. Work is counted, never timed.
 */
import { planNight, subjectOrderKey, type PlannedFact } from '@/lib/continuity/night-plan';

const facts = (prefix: string, count: number, at = 0): PlannedFact[] => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, createdAt: at + i }));
const subjects = [
    { key: subjectOrderKey('CHARACTER', 'w'), facts: facts('w', 4) },
    { key: subjectOrderKey('CHARACTER', 'm'), facts: facts('m', 3) },
    { key: subjectOrderKey('SETTING', 'h'), facts: facts('h', 5) },
    { key: subjectOrderKey('FACTION', 'g'), facts: facts('g', 2) },
];
const base = { maxCalls: 2, maxFacts: 8, minFacts: 2, budget: 1_000, worst: () => 0 };

describe('planNight', () => {
    it('packs whole subjects in a stable order, at most maxCalls calls of at most maxFacts facts', () => {
        const plan = planNight({ ...base, maxCalls: 1, subjects, cursor: null });
        expect(plan.calls).toHaveLength(1);
        // Order: CHARACTER Marrow, CHARACTER Wren, FACTION Guild, SETTING Harrow Weir; Guild would pass 8 facts.
        expect(plan.calls[0].subjectKeys).toEqual([subjects[1].key, subjects[0].key]);
        expect(plan.calls[0].facts).toHaveLength(7);
        expect(plan.covered).toBe(2);
        expect(plan.remaining).toBe(2);
        expect(plan.cursor).toBe(subjects[0].key);
        const two = planNight({ ...base, subjects, cursor: null });
        expect(two.calls.map((c) => c.subjectKeys)).toEqual([[subjects[1].key, subjects[0].key], [subjects[3].key, subjects[2].key]]);
        for (const c of two.calls) expect(c.facts.length).toBeLessThanOrEqual(8);
    });

    it('resumes from the cursor: the next night takes what is left, and a finished pass leaves nothing', () => {
        const first = planNight({ ...base, maxCalls: 1, subjects, cursor: null });
        const second = planNight({ ...base, maxCalls: 1, subjects, cursor: first.cursor });
        expect(second.calls.flatMap((c) => c.subjectKeys)).toEqual([subjects[3].key, subjects[2].key]);
        expect(second.remaining).toBe(0);
        const third = planNight({ ...base, maxCalls: 1, subjects, cursor: second.cursor });
        expect(third.calls).toEqual([]);
        expect(third.covered).toBe(0);
    });

    it('gives an oversized subject a call of its own, its newest facts, the rest counted', () => {
        const plan = planNight({ ...base, maxCalls: 1, subjects: [{ key: 'a', facts: facts('x', 20) }], cursor: null });
        expect(plan.calls).toHaveLength(1);
        expect(plan.calls[0].facts.map((f) => f.id)).toEqual(['x19', 'x18', 'x17', 'x16', 'x15', 'x14', 'x13', 'x12']);
        expect(plan.cut).toBe(12);
    });

    it('holds the per-call budget: drops whole subjects, then halves a lone one, else stops over budget', () => {
        const worst = (fs: readonly PlannedFact[]) => fs.length * 100;
        const plan = planNight({ ...base, budget: 500, worst, subjects, cursor: null });
        for (const c of plan.calls) expect(worst(c.facts)).toBeLessThanOrEqual(500);
        const lone = planNight({ ...base, maxFacts: 8, budget: 350, worst, subjects: [{ key: 'a', facts: facts('x', 8) }], cursor: null });
        expect(lone.calls[0].facts.length).toBe(2);
        const none = planNight({ ...base, budget: 50, worst, subjects, cursor: null });
        expect(none.overBudget).toBe(true);
        expect(none.calls).toEqual([]);
        expect(none.cursor).toBeNull();
    });

    it('an empty pass plans nothing (rule 6: nothing checked is never complete coverage claimed)', () => {
        const plan = planNight({ ...base, subjects: [], cursor: null });
        expect(plan).toMatchObject({ calls: [], covered: 0, remaining: 0, cursor: null });
    });
});
