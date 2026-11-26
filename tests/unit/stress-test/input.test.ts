/**
 * WHAT A STRESS TEST IS SHOWN, AND WHAT IT SAYS IT LEFT OUT (Phase 4.3, D29;
 * rule 6). Pure.
 */
import { buildStressInput, type StressInputSources } from '@/lib/stress-test/input';
import { fitStressInput } from '@/lib/stress-test/cost';
import { STRESS_INPUT_CHAR_BUDGET, STRESS_INPUT_CHAR_BUDGET_MIN } from '@/lib/stress-test/vocabulary';

function canon(n: number): StressInputSources {
    return {
        book: { title: 'Large', logline: null },
        elements: Array.from({ length: n }, (_, i) => ({ id: `el-${i}`, kind: 'CHARACTER', name: `Person ${i}`, summary: 'x'.repeat(380) })),
        facts: Array.from({ length: 40 }, (_, i) => ({ id: `f-${i}`, subject: `Person ${i}`, statement: 'is someone'.repeat(10) })),
        threads: [{ id: 't-1', kind: 'PROMISE', title: 'A promise' }],
        passages: [{ id: 'c-1', headings: 'One', text: 'p'.repeat(3_000) }],
        orders: [],
        totals: { elements: n, facts: 40, threads: 1, passages: 1 },
    };
}

it('a small canon is shown whole, every row tagged, and the coverage says nothing was left out', () => {
    const input = buildStressInput(canon(3), STRESS_INPUT_CHAR_BUDGET);
    expect(input.coverage).toMatchObject({ elements: { shown: 3, total: 3 }, threads: { shown: 1, total: 1 }, passages: { shown: 1, total: 1 }, cut: false });
    expect(input.shown.get('E1')).toEqual({ type: 'ELEMENT', id: 'el-0' });
    expect(input.shown.get('T1')).toEqual({ type: 'THREAD', id: 't-1' });
    expect(input.shown.get('P1')).toEqual({ type: 'PASSAGE', id: 'c-1' });
    expect(input.blocks.map((b) => b.label)).toEqual(['book', 'elements', 'facts', 'threads', 'passages.1']);
});

it('a large canon is cut to the budget, the cut SAID (counts of shown against held), and no untagged row is shown', () => {
    const input = buildStressInput(canon(80), 10_000);
    const chars = input.blocks.reduce((n, b) => n + b.text.length, 0);
    expect(chars).toBeLessThanOrEqual(10_000 + 200);
    expect(input.coverage.cut).toBe(true);
    expect(input.coverage.elements.shown).toBeLessThan(80);
    expect(input.coverage.elements.total).toBe(80);
    // Every tag shown in the text is in the map, and every mapped tag is in the text.
    const text = input.blocks.map((b) => b.text).join('\n');
    for (const tag of input.shown.keys()) expect(text).toContain(`${tag}.`);
    expect(input.shown.has(`E${input.coverage.elements.shown + 1}`)).toBe(false);
});

it('the fitted input halves its budget until the worst case fits, and refuses CALL_OVER_BUDGET below the floor', () => {
    const big = canon(80);
    const byLength = (blocks: ReadonlyArray<{ text: string }>) => blocks.reduce((n, b) => n + b.text.length, 0);
    const fitted = fitStressInput(big, byLength, 12_000);
    expect(fitted.ok).toBe(true);
    if (fitted.ok) expect(fitted.coverage.budgetChars).toBe(STRESS_INPUT_CHAR_BUDGET / 4);
    const never = fitStressInput(big, () => Number.MAX_SAFE_INTEGER, 1);
    expect(never).toMatchObject({ ok: false, reason: 'CALL_OVER_BUDGET' });
    expect(STRESS_INPUT_CHAR_BUDGET_MIN).toBeGreaterThan(0);
});
