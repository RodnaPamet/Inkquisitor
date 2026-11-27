/**
 * Contradiction precision (Phase 4.H-b, roadmap 4.H item 2): the code detectors
 * graded over seeded contradictions and near misses (`rule-precision.json`),
 * on both paths production raises them by — 4.2's nightly sweep and 4.1's
 * resolve at extraction. Fewer than one false alarm in ten (precision ≥ 0.9
 * over every alarm raised); recall is reported, and held too, so the bar is
 * never met by raising nothing.
 */
import { gradeRulePrecision, RULE_PRECISION_BAR, rulePrecisionCases } from '@/lib/continuity/evals/rule-precision';

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
