/**
 * Contradiction precision (Phase 4.H-b, roadmap 4.H item 2): the code detectors
 * graded over seeded contradictions and near misses (`rule-precision.json`),
 * on both paths production raises them by — 4.2's nightly sweep and 4.1's
 * resolve at extraction. Fewer than one false alarm in ten (precision ≥ 0.9
 * over every alarm raised); recall is reported, and held too, so the bar is
 * never met by raising nothing.
 */
import { gradeRulePrecision, RULE_PRECISION_BAR, rulePrecisionCases } from '@/lib/continuity/evals/rule-precision';
import { ruleContradiction, type RuleFact } from '@/lib/continuity/rules';

const grades = gradeRulePrecision();

afterAll(() => {
    for (const [path, g] of Object.entries(grades)) {
        process.stderr.write(
            `rule precision (${path}): ${g.trueAlarms} of ${g.alarms} alarms true — precision ${g.precision?.toFixed(3)}, recall ${g.recall?.toFixed(3)} ` +
                `(${g.expected} seeded); false alarms: ${g.falseAlarms.map((f) => `${f.caseId} ${f.pair}`).join(', ') || 'none'}; missed: ${g.missed.map((m) => `${m.caseId} ${m.pair}`).join(', ') || 'none'}\n`,
        );
    }
});

it('the set is seeded and has near misses of every class the roadmap names (a set of one kind proves nothing)', () => {
    const seeded = rulePrecisionCases.filter((c) => c.id.startsWith('rp'));
    const near = rulePrecisionCases.filter((c) => c.id.startsWith('nm'));
    expect(seeded.length).toBeGreaterThanOrEqual(20);
    expect(near.length).toBeGreaterThanOrEqual(25);
    expect(new Set(seeded.flatMap((c) => c.expect.map((e) => e.kind)))).toEqual(new Set(['VALUE', 'WHEREABOUTS', 'KNOWLEDGE']));
});

it.each(['nightly', 'resolve'] as const)('%s: fewer than one false alarm in ten, and the seeded contradictions found', (path) => {
    const g = grades[path];
    expect(g.alarms).toBeGreaterThan(0);
    expect(g.precision).not.toBeNull();
    expect(g.precision!).toBeGreaterThanOrEqual(RULE_PRECISION_BAR);
    // Recall is reported; it is also held, so the precision bar cannot be met by raising less.
    expect(g.recall!).toBeGreaterThanOrEqual(0.9);
});

it('the near misses fixed by 4.H-b stay quiet on both paths (each one reverts to an alarm if its refusal is removed)', () => {
    const fixed = ['nm-03', 'nm-06', 'nm-08', 'nm-10', 'nm-12', 'nm-17', 'nm-19', 'nm-20', 'nm-21', 'nm-29'];
    for (const g of Object.values(grades)) expect(g.falseAlarms.filter((f) => fixed.includes(f.caseId))).toEqual([]);
});

it('the one residual false alarm is the synonym of one shape, and it is counted, not hidden', () => {
    for (const g of Object.values(grades)) expect(g.falseAlarms.map((f) => f.caseId)).toEqual(['nm-25']);
});

/**
 * The 4.H-b review: each refusal is NARROW — it takes the near miss it names and no real contradiction beside it.
 * Each pair below is a real contradiction that a broader refusal (any negating word in the statement, any comparative
 * in it, any question word) silenced; it must still be raised.
 */
describe('the refusals stay narrow (the 4.H-b review)', () => {
    const fact = (id: string, predicate: string, statement: string, objectLiteral: string | null): RuleFact => ({
        id,
        predicate,
        statement,
        objectLiteral,
        subjectElementId: 'wren',
        // One stated time on both: KNOWLEDGE and WHEREABOUTS clash only when their times decide it (D28 addendum).
        storyTimeFrom: 'midsummer',
        storyTimeTo: null,
        ownerElementId: null,
    });

    it.each([
        ['a negation in ANOTHER clause negates no value', fact('a', 'OCCUPATION', 'Wren, who never married, is a baker.', 'a baker'), fact('b', 'OCCUPATION', 'Wren is a smith.', 'a smith'), 'VALUE'],
        ['a negation AFTER the value negates no value', fact('a', 'OCCUPATION', 'Wren is a baker and no friend of the miller.', 'a baker'), fact('b', 'OCCUPATION', 'Wren is a smith.', 'a smith'), 'VALUE'],
        ['a contrast after an age', fact('a', 'AGE', 'Wren is 40, not 30.', '40'), fact('b', 'AGE', 'Wren is 35.', '35'), 'VALUE'],
        ['a comparative in another clause leaves the age stated', fact('a', 'AGE', 'Wren, 12, is younger than her brother.', '12'), fact('b', 'AGE', 'Wren is 15.', '15'), 'VALUE'],
        ['a comparative bound to nothing numeric', fact('a', 'AGE', 'Wren is 12 and taller than Ash.', '12'), fact('b', 'AGE', 'Wren is 15.', '15'), 'VALUE'],
        ['a relative pronoun is not a question word', fact('a', 'KNOWLEDGE', 'Wren knows the man who forged the deed.', null), fact('b', 'KNOWLEDGE', 'Wren does not know the man that forged the deed.', null), 'KNOWLEDGE'],
    ] as const)('%s: still raised', (_label, a, b, kind) => {
        expect(ruleContradiction(a, b)).toBe(kind);
    });

    it.each([
        ['a negated value', fact('a', 'OCCUPATION', 'Wren is not a baker.', 'a baker'), fact('b', 'OCCUPATION', 'Wren is a smith.', 'a smith')],
        ['an age not yet reached', fact('a', 'AGE', 'Wren is not yet 13.', '13'), fact('b', 'AGE', 'Wren is 12.', '12')],
        ['an age relative to someone', fact('a', 'AGE', 'Wren is 3 years younger than Tomas.', '3 years younger than Tomas'), fact('b', 'AGE', 'Wren is 12.', '12')],
        ['an age stated as younger than someone, by a number', fact('a', 'AGE', 'Wren is younger than Tomas by 3 years.', null), fact('b', 'AGE', 'Wren is 12.', '12')],
        ['knowing that, not knowing who', fact('a', 'KNOWLEDGE', 'Wren knows the deed was forged.', null), fact('b', 'KNOWLEDGE', 'Wren does not know who forged the deed.', null)],
    ] as const)('%s: still refused', (_label, a, b) => {
        expect(ruleContradiction(a, b)).toBeNull();
    });
});
