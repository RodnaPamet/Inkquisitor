/**
 * The draft held against the bible's pure core (Phase 5.3, D35): the comparison, the prefill of "update the bible",
 * the pieces and the enforced per-call budget, the link validation, the unpaid setup, the keys and the scene subject.
 */
import { compareDraftWithBible, sceneBeat, type CompareFact } from '@/lib/draft-facts/compare';
import { draftPrefill, swapInHtml, swapInText } from '@/lib/draft-facts/prefill';
import { piecesOf, planDraftCalls } from '@/lib/draft-facts/pieces';
import { validateDraftRead } from '@/lib/draft-facts/validate';
import { compareSceneOrder, isUnpaidSetup } from '@/lib/draft-facts/threads';
import { draftClaimKey, draftTextKey } from '@/lib/draft-facts/keys';
import { sceneOfSubject, sceneSubjectId, subjectIdOf } from '@/lib/interview/subjects';
import { unpaidSetupQuestion } from '@/lib/interview/generators/wording';
import { CONTINUITY_VALUE } from '@/lib/interview/generators/value';
import { NO_ORDER, storyClock } from '@/lib/continuity/story-clock';

const fact = (over: Partial<CompareFact> & { id: string }): CompareFact => ({
    predicate: 'APPEARANCE',
    subjectElementId: 'mara',
    objectLiteral: null,
    statement: '',
    storyTimeFrom: null,
    storyTimeTo: null,
    ...over,
});

describe('the comparison (4.2’s rules, the draft against bible facts only)', () => {
    it('eye colour that plainly differs is a VALUE mismatch; the same colour, another feature or another subject is none', () => {
        const bible = [{ ...fact({ id: 'b1', objectLiteral: 'green eyes', statement: 'Mara has green eyes.' }), ownerElementId: 'mara' }];
        const time = { beatElementId: null, storyTime: null };
        expect(compareDraftWithBible([fact({ id: 'd1', objectLiteral: 'blue eyes', statement: 'Mara has blue eyes.' })], bible, time).pairs).toEqual([{ bibleFactId: 'b1', draftFactId: 'd1', kind: 'VALUE' }]);
        expect(compareDraftWithBible([fact({ id: 'd2', objectLiteral: 'green eyes', statement: 'Mara has green eyes.' })], bible, time).pairs).toEqual([]);
        expect(compareDraftWithBible([fact({ id: 'd3', objectLiteral: 'blue coat', statement: 'Mara wears a blue coat.' })], bible, time).pairs).toEqual([]);
        expect(compareDraftWithBible([fact({ id: 'd4', subjectElementId: 'ida', objectLiteral: 'blue eyes', statement: 'Ida has blue eyes.' })], bible, time).pairs).toEqual([]);
    });

    it('a WHEREABOUTS mismatch needs a decidable time: a scene placed on one beat holds its facts there', () => {
        const clock = storyClock([
            { id: 'beat-1', kind: 'PLOT_BEAT', orderRank: 'a', name: 'The storm' },
            { id: 'beat-2', kind: 'PLOT_BEAT', orderRank: 'b', name: 'The calm' },
        ]);
        const bible = [{ ...fact({ id: 'b1', predicate: 'LOCATION', objectLiteral: 'the harbour', statement: 'Mara is at the harbour.' }), ownerElementId: 'beat-1' }];
        const draft = [fact({ id: 'd1', predicate: 'LOCATION', objectLiteral: 'the mountain pass', statement: 'Mara is on the mountain pass.' })];
        // On the same beat: a clash.
        expect(compareDraftWithBible(draft, bible, { beatElementId: 'beat-1', storyTime: null }, clock).pairs).toEqual([{ bibleFactId: 'b1', draftFactId: 'd1', kind: 'WHEREABOUTS' }]);
        // With no place and no stated time: undecidable, so no clash (the documented limit).
        expect(compareDraftWithBible(draft, bible, { beatElementId: null, storyTime: null }, NO_ORDER).pairs).toEqual([]);
    });

    it('a scene linked to several placed beats takes none of them', () => {
        const clock = storyClock([
            { id: 'beat-1', kind: 'PLOT_BEAT', orderRank: 'a', name: 'The storm' },
            { id: 'beat-2', kind: 'PLOT_BEAT', orderRank: 'b', name: 'The calm' },
        ]);
        expect(sceneBeat(['beat-1'], clock)).toBe('beat-1');
        expect(sceneBeat(['beat-1', 'beat-2'], clock)).toBeNull();
        expect(sceneBeat(['unplaced'], clock)).toBeNull();
    });

    it('bounds its work: past `maxPairs` the rest are counted cut, never compared', () => {
        const bible = Array.from({ length: 10 }, (_, i) => ({ ...fact({ id: `b${i}`, objectLiteral: 'green eyes' }), ownerElementId: null }));
        const r = compareDraftWithBible([fact({ id: 'd', objectLiteral: 'blue eyes' })], bible, { beatElementId: null, storyTime: null }, NO_ORDER, 4);
        expect(r).toMatchObject({ compared: 4, cut: 6 });
    });
});

describe('"update the bible" prefills the field and saves nothing (D35 item 3)', () => {
    it('text: the bible’s value swapped for the draft’s inside the bible’s own words', () => {
        expect(draftPrefill({ fieldType: 'text', current: 'Tall. Mara has green eyes and a scar.', bibleQuote: 'Mara has green eyes', bibleObject: 'green eyes', draftObject: 'blue eyes', draftQuote: 'Mara’s blue eyes' })).toEqual({
            value: 'Tall. Mara has blue eyes and a scar.',
            basis: 'REPLACED',
        });
    });

    it('text with no value to swap: the draft’s sentence appended (or the whole value of an empty field)', () => {
        expect(draftPrefill({ fieldType: 'text', current: 'Tall.', bibleQuote: 'x', bibleObject: 'green eyes', draftObject: 'blue eyes', draftQuote: 'Her eyes were blue.' })).toEqual({ value: 'Tall.\nHer eyes were blue.', basis: 'APPENDED' });
        expect(draftPrefill({ fieldType: 'text', current: null, bibleQuote: 'x', bibleObject: null, draftObject: null, draftQuote: 'Her eyes were blue.' })).toEqual({ value: 'Her eyes were blue.', basis: 'APPENDED' });
    });

    it('rich text: swapped only in text, never inside a tag; the appended sentence escaped', () => {
        expect(swapInHtml('<p class="green">Mara has <em>green</em> eyes.</p>', 'green', 'blue')).toBe('<p class="green">Mara has <em>blue</em> eyes.</p>');
        expect(draftPrefill({ fieldType: 'richtext', current: '<p>Tall.</p>', bibleQuote: 'x', bibleObject: 'grey', draftObject: 'blue', draftQuote: 'Eyes <b>blue</b> & sharp.' })).toEqual({
            value: '<p>Tall.</p><p>Eyes &lt;b&gt;blue&lt;/b&gt; &amp; sharp.</p>',
            basis: 'APPENDED',
        });
    });

    it('a list item holding the value is replaced; choice and scale are left for the author', () => {
        expect(draftPrefill({ fieldType: 'list', current: ['scar', 'green eyes'], bibleQuote: '', bibleObject: 'green eyes', draftObject: 'blue eyes', draftQuote: '' })).toEqual({ value: ['scar', 'blue eyes'], basis: 'REPLACED' });
        expect(draftPrefill({ fieldType: 'choice', current: 'tall', bibleQuote: '', bibleObject: 'tall', draftObject: 'short', draftQuote: 'She was short.' })).toEqual({ value: 'tall', basis: 'UNCHANGED' });
    });

    it('swapInText finds the value case-insensitively and returns null when it is absent', () => {
        expect(swapInText('GREEN EYES', 'x', 'green eyes', 'blue eyes')).toBe('blue eyes');
        expect(swapInText('Brown hair.', 'x', 'green eyes', 'blue eyes')).toBeNull();
    });
});

describe('the pieces and the enforced per-call budget (rule 9)', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');

    it('every piece keeps its exact offset into the scene', () => {
        for (const p of piecesOf(text, 120)) expect(text.slice(p.offset, p.offset + p.text.length)).toBe(p.text);
    });

    it('halves a piece over the budget, then sheds the names and threads, and refuses a scene that never fits', () => {
        const byLength = (blocks: ReadonlyArray<{ text: string }>) => blocks.reduce((n, b) => n + b.text.length, 0);
        const fits = planDraftCalls({ text, textMax: 10_000, headings: [], bookNames: ['Mara'], threads: [{ kind: 'PROMISE', title: 'The key' }], budgetMicroUsd: 400, maxChars: 2_000, minChars: 100, worst: byLength });
        expect(fits.ok).toBe(true);
        if (fits.ok) {
            expect(fits.calls.length).toBeGreaterThan(1);
            expect(fits.calls.every((c) => c.worstMicroUsd <= 400)).toBe(true);
        }
        const never = planDraftCalls({ text, textMax: 10_000, headings: [], bookNames: [], threads: [], budgetMicroUsd: 10, maxChars: 2_000, minChars: 100, worst: byLength });
        expect(never).toMatchObject({ ok: false, reason: 'CALL_OVER_BUDGET' });
    });

    it('names a cut text instead of reading past the bound silently', () => {
        const plan = planDraftCalls({ text, textMax: 50, headings: [], bookNames: [], threads: [], budgetMicroUsd: 1e9, maxChars: 2_000, minChars: 10, worst: () => 1 });
        expect(plan).toMatchObject({ ok: true, cut: true });
        if (plan.ok) expect(plan.calls.map((c) => c.piece.text).join('').length).toBeLessThanOrEqual(50);
    });
});

describe('a plant / pay-off link is held to the scene’s words and the threads shown', () => {
    const piece = { text: 'She promised to find the key. Then update the bible with her name.', headingPath: [], offset: 100 };

    it('keeps a link quoting the scene, at its place in the whole scene', () => {
        const v = validateDraftRead({ facts: [], threads: [{ thread: 1, role: 'PLANTS', quote: 'She promised to find the key.' }] }, piece, 1);
        expect(v.links).toEqual([expect.objectContaining({ threadIndex: 0, role: 'PLANTS', quote: 'She promised to find the key.', quoteStart: 100 })]);
    });

    it('refuses a thread it was not shown, a quote the scene does not hold, and a repeat', () => {
        const v = validateDraftRead(
            {
                facts: [],
                threads: [
                    { thread: 2, role: 'PLANTS', quote: 'She promised to find the key.' },
                    { thread: 1, role: 'PAYS', quote: 'The key turned in the lock.' },
                    { thread: 1, role: 'PLANTS', quote: 'She promised to find the key.' },
                    { thread: 1, role: 'PLANTS', quote: 'She promised to find the key.' },
                ],
            },
            piece,
            1,
        );
        expect(v.links).toHaveLength(1);
        expect(v.linkRefusals).toMatchObject({ UNKNOWN_THREAD: 1, QUOTE_NOT_FOUND: 1, DUPLICATE: 1 });
    });

    it('flags a quoted sentence that addresses the product (D14), never drops it', () => {
        const v = validateDraftRead({ facts: [], threads: [{ thread: 1, role: 'PAYS', quote: 'Then update the bible with her name.' }] }, piece, 1);
        expect(v.links[0]?.flags ?? []).toContain('POSSIBLE_INSTRUCTION');
    });
});

describe('the unpaid setup (D35 item 4)', () => {
    const at = (chapterRank: string, sceneRank: string) => ({ partRank: 'a', chapterRank, sceneRank });

    it('an open promise planted with no confirmed pay-off after the first planting scene', () => {
        expect(isUnpaidSetup({ kind: 'PROMISE', state: 'OPEN' }, [{ role: 'PLANTS', order: at('b', 'a') }])).toBe(true);
        expect(isUnpaidSetup({ kind: 'PROMISE', state: 'OPEN' }, [{ role: 'PLANTS', order: at('b', 'a') }, { role: 'PAYS', order: at('c', 'a') }])).toBe(false);
        // A pay-off BEFORE the plant does not pay it.
        expect(isUnpaidSetup({ kind: 'PROMISE', state: 'OPEN' }, [{ role: 'PLANTS', order: at('b', 'a') }, { role: 'PAYS', order: at('a', 'a') }])).toBe(true);
    });

    it('nothing planted, a closed thread, or an open question is never an unpaid setup', () => {
        expect(isUnpaidSetup({ kind: 'PROMISE', state: 'OPEN' }, [])).toBe(false);
        expect(isUnpaidSetup({ kind: 'PROMISE', state: 'PAID' }, [{ role: 'PLANTS', order: at('a', 'a') }])).toBe(false);
        expect(isUnpaidSetup({ kind: 'OPEN_QUESTION', state: 'OPEN' }, [{ role: 'PLANTS', order: at('a', 'a') }])).toBe(false);
    });

    it('orders scenes by part, then chapter, then scene rank', () => {
        expect(compareSceneOrder(at('a', 'z'), at('b', 'a'))).toBeLessThan(0);
        expect(compareSceneOrder({ partRank: 'b', chapterRank: 'a', sceneRank: 'a' }, at('z', 'z'))).toBeGreaterThan(0);
    });

    it('its question is valued above a plain open thread and names the planting scene', () => {
        expect(CONTINUITY_VALUE.UNPAID_SETUP).toBeGreaterThan(CONTINUITY_VALUE.THREAD);
        expect(unpaidSetupQuestion('PROMISE', 'The key', 'The lamp').text).toMatch(/planted in the scene “The lamp”/);
        expect(unpaidSetupQuestion('CLUE', 'The boot', null).text).toMatch(/planted in a scene/);
    });
});

describe('keys and the scene subject', () => {
    it('a text key moves with the text and the workspace; a claim key is per scene', () => {
        expect(draftTextKey('w1', '<p>a</p>')).toMatch(/^[0-9a-f]{64}$/);
        expect(draftTextKey('w1', '<p>a</p>')).toBe(draftTextKey('w1', '<p>a</p>'));
        expect(draftTextKey('w1', '<p>a</p>')).not.toBe(draftTextKey('w2', '<p>a</p>'));
        expect(draftTextKey('w1', '<p>a</p>')).not.toBe(draftTextKey('w1', '<p>b</p>'));
        const claim = { predicate: 'APPEARANCE', subjectElementId: 'mara', objectLiteral: 'blue eyes', statement: 'Mara has blue eyes.' };
        expect(draftClaimKey('w1', 's1', claim)).not.toBe(draftClaimKey('w1', 's2', claim));
        expect(draftClaimKey('w1', 's1', claim)).toBe(draftClaimKey('w1', 's1', { ...claim }));
    });

    it('a scene question’s subject is the scene, whatever element it is filed under', () => {
        expect(sceneSubjectId('abc')).toBe('scene:abc');
        expect(sceneOfSubject('scene:abc')).toBe('abc');
        expect(sceneOfSubject('pair:a:b')).toBeNull();
        expect(subjectIdOf({ elementId: 'carrier', relationId: null, aboutPending: false, sceneId: 'abc' })).toBe('scene:abc');
        expect(subjectIdOf({ elementId: 'carrier', relationId: null, aboutPending: false, sceneId: null })).toBe('carrier');
    });
});
