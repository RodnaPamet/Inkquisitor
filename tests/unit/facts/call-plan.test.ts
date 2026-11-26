/**
 * ONE CALL'S INPUT IS BOUNDED, AND ITS WORST CASE FITS THE BUDGET (owner decisions of 2026-11-21, the D27
 * addendum): a long changed section is cut into pieces at block boundaries, every piece a run of the entry's own
 * text; a call past the per-call budget is halved, then sheds the book's names and existing facts; with nothing
 * that fits, nothing is planned. And the bound itself: on the default fast model, a 20,000-character piece with
 * ordinary context fits the budget.
 */
import { buildSnapshot } from '@/lib/bible/snapshot';
import { planBibleFactCalls } from '@/lib/facts/call-plan';
import { bibleFactsCallWorstCase } from '@/lib/facts/cost';
import { cutText, entryText, pieceSections, renderElementEntry, type EntrySection } from '@/lib/facts/entry-text';
import { BIBLE_FACTS_CALL_COST_BUDGET_MICRO_USD, bibleFactBlocks } from '@/lib/facts/prompt';
import { BIBLE_FACT_PIECE_MAX_CHARS, BIBLE_FACT_PIECE_MIN_CHARS } from '@/lib/facts/vocabulary';

const paragraph = (i: number) => `Wren remembers the winter of the flood, part ${i}. ${'The river rose over the weir and the lock gates groaned. '.repeat(14)}`.trim();
const longWound = (n: number) => Array.from({ length: n }, (_, i) => `<p>${paragraph(i)}</p>`).join('');

const entryWith = (wound: string) =>
    renderElementEntry(buildSnapshot({ element: { kind: 'CHARACTER', name: 'Wren', slug: 'wren', status: 'DRAFT', summary: 'Wren keeps the lock.', customLabel: null }, fields: [{ key: 'wound', value: wound, order: 1 }] }));

describe('pieces', () => {
    it('cuts a section longer than the bound at paragraph boundaries into runs of its own text, none past the bound', () => {
        const entry = entryWith(longWound(70));
        const wound = entry.body.find((s) => s.key === 'wound')!;
        expect(wound.text.length).toBeGreaterThan(2 * BIBLE_FACT_PIECE_MAX_CHARS);
        const batches = pieceSections(entry.body, BIBLE_FACT_PIECE_MAX_CHARS);
        const pieces = batches.flat().filter((s) => s.key === 'wound');
        expect(pieces.length).toBeGreaterThanOrEqual(3);
        const whole = entryText(entry);
        for (const p of pieces) {
            expect(p.text.length).toBeLessThanOrEqual(BIBLE_FACT_PIECE_MAX_CHARS);
            expect(wound.text.includes(p.text)).toBe(true);
            expect(whole.includes(p.text)).toBe(true);
            // A paragraph boundary: every piece opens a paragraph.
            expect(p.text.startsWith('Wren remembers the winter of the flood, part ')).toBe(true);
        }
        // Nothing of the section is lost between pieces.
        expect(pieces.map((p) => p.text).join(' ')).toBe(wound.text);
    });

    it('packs short sections together, in order, and cuts an unbroken run after a sentence or at a space', () => {
        const short: EntrySection[] = [
            { key: 'a', label: 'A', text: 'one two' },
            { key: 'b', label: 'B', text: 'three four' },
        ];
        expect(pieceSections(short, 100)).toEqual([short]);
        expect(cutText('Alpha beta. Gamma delta epsilon', [], 20).map((p) => p.text)).toEqual(['Alpha beta.', 'Gamma delta epsilon']);
        expect(cutText('aaaa bbbb cccc', [], 9).map((p) => p.text)).toEqual(['aaaa', 'bbbb cccc']);
        // One unbroken run is cut at the bound, never inside a surrogate pair.
        const emoji = '😀'.repeat(6);
        for (const p of cutText(emoji, [], 5)) expect(p.text.length % 2).toBe(0);
    });
});

describe('the plan', () => {
    const entry = entryWith(longWound(70));
    const shown = Array.from({ length: 8 }, (_, i) => ({ predicate: 'OTHER', statement: `Existing fact ${i} about Wren.`, storyTimeFrom: null, storyTimeTo: null }));
    const base = { entry, changed: entry.body, subjects: ['Wren'], shown, bookNames: ['Wren', 'Harrow Weir'], maxChars: BIBLE_FACT_PIECE_MAX_CHARS, minChars: BIBLE_FACT_PIECE_MIN_CHARS };
    const bytes = (blocks: ReadonlyArray<{ text: string }>) => blocks.reduce((n, b) => n + b.text.length, 0);

    it('every planned call fits the budget, and covers every changed section', () => {
        const plan = planBibleFactCalls({ ...base, budgetMicroUsd: 1_000_000, worst: bytes });
        if (!plan.ok) throw new Error('expected a plan');
        expect(plan.calls.length).toBeGreaterThanOrEqual(3);
        for (const c of plan.calls) expect(c.worstMicroUsd).toBeLessThanOrEqual(1_000_000);
        expect(plan.calls.some((c) => c.sent.includes('Summary: Wren keeps the lock.'))).toBe(true);
    });

    it('a call past the budget is halved before it loses context, then sheds the names, then the existing facts', () => {
        const halved = planBibleFactCalls({ ...base, budgetMicroUsd: 12_000, worst: bytes });
        if (!halved.ok) throw new Error('expected a plan');
        expect(halved.calls.every((c) => c.worstMicroUsd <= 12_000 && c.shown === shown.length)).toBe(true);
        const roomy = planBibleFactCalls({ ...base, budgetMicroUsd: 1_000_000, worst: bytes });
        if (!roomy.ok) throw new Error('expected a plan');
        expect(halved.calls.length).toBeGreaterThan(roomy.calls.length);
        // At the floor, with only room for the piece and the header: no names, fewer facts shown (a prefix).
        const tight = planBibleFactCalls({ ...base, budgetMicroUsd: BIBLE_FACT_PIECE_MIN_CHARS, worst: bytes });
        if (!tight.ok) throw new Error('expected a plan');
        expect(tight.calls.some((c) => c.shown < shown.length)).toBe(true);
        expect(tight.calls.every((c) => c.worstMicroUsd <= BIBLE_FACT_PIECE_MIN_CHARS)).toBe(true);
        expect(tight.calls.every((c) => !c.blocks.some((b) => b.label === 'book-names') || c.shown === shown.length)).toBe(true);
    });

    it('nothing fits: nothing is planned', () => {
        expect(planBibleFactCalls({ ...base, budgetMicroUsd: 10, worst: bytes })).toMatchObject({ ok: false, reason: 'CALL_OVER_BUDGET' });
    });

    it('the bound is what the budget takes: a 20,000-character piece with ordinary context fits on the default fast model', () => {
        const piece = 'Wren keeps the lock at Harrow Weir and remembers the flood. '.repeat(400).slice(0, BIBLE_FACT_PIECE_MAX_CHARS);
        const blocks = bibleFactBlocks({ text: `Name: Wren\nKind: Character\nWound: ${piece}`, subjects: ['Wren'], existing: shown.slice(0, 12), bookNames: Array.from({ length: 40 }, (_, i) => `Element number ${i}`) });
        expect(bibleFactsCallWorstCase(blocks)).toBeLessThanOrEqual(BIBLE_FACTS_CALL_COST_BUDGET_MICRO_USD);
    });
});
