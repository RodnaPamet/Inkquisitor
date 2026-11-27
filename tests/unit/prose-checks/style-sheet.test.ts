/**
 * The style sheet, compiled (Phase 5.2, D34): which STYLE element is the
 * book's sheet, and what the checks read from its structured fields.
 */
import { getTemplate } from '@/lib/bible/templates';
import { normaliseFieldValue } from '@/lib/bible/field-values';
import { rulesNotRunFor } from '@/lib/prose-checks/engine';
import { canonicalSheet, compileStyleSheet, EMPTY_STYLE_SHEET, normaliseWordItem, parseSwap, pickStyleSheetElement } from '@/lib/prose-checks/style-sheet';
import { STYLE_PERSONS, STYLE_QUOTE_MARKS, STYLE_SPELLINGS, STYLE_TAG_PUNCTUATION, STYLE_TENSES } from '@/lib/prose-checks/vocabulary';

const at = (ms: number) => new Date(Date.UTC(2026, 10, 1) + ms);

describe('which element is the book’s style sheet', () => {
    it('is the oldest whole-book STYLE element; failing one, the oldest with no span; never a part’s', () => {
        const part = { id: 'p', createdAt: at(0), fields: { style_scope: 'one_part' } };
        const unscoped = { id: 'u', createdAt: at(1), fields: {} };
        const whole2 = { id: 'w2', createdAt: at(3), fields: { style_scope: 'whole_book' } };
        const whole1 = { id: 'w1', createdAt: at(2), fields: { style_scope: 'whole_book' } };
        expect(pickStyleSheetElement([part, unscoped, whole2, whole1])?.id).toBe('w1');
        expect(pickStyleSheetElement([part, unscoped])?.id).toBe('u');
        expect(pickStyleSheetElement([part])).toBeNull();
        expect(pickStyleSheetElement([])).toBeNull();
    });
});

describe('compiling the sheet', () => {
    it('reads the choices, the avoided words that are words, and the swaps', () => {
        const sheet = compileStyleSheet('s', {
            check_tense: 'past',
            check_person: 'third_limited',
            check_spelling: 'british',
            quote_marks: 'single',
            tag_punctuation: 'inside',
            avoided_words: ['Suddenly', 'very  very', 'sentences that start with a gerund and run on for ever', 'utilise'],
            word_swaps: ['utilise → use', 'whilst -> while', 'amongst => among', 'no separator here', 'a → b → c'],
        });
        expect(sheet).toMatchObject({ elementId: 's', tense: 'past', person: 'third_limited', spelling: 'british', quoteMarks: 'single', tagPunctuation: 'inside' });
        // "utilise" has a swap, so it is in the swaps and not twice.
        expect(sheet.banned).toEqual(['suddenly', 'very very']);
        expect(sheet.swaps).toEqual([
            { from: 'amongst', to: 'among' },
            { from: 'utilise', to: 'use' },
            { from: 'whilst', to: 'while' },
        ]);
        expect(sheet.ignoredItems).toBe(3);
    });
    it('reads a value outside the options as unset (a template edit never makes a stored value run a rule)', () => {
        const sheet = compileStyleSheet('s', { check_tense: 'future', check_spelling: 'klingon' });
        expect(sheet.tense).toBeNull();
        expect(sheet.spelling).toBeNull();
        expect(rulesNotRunFor(sheet)).toEqual(expect.arrayContaining(['tense-slip', 'spelling-variant', 'banned-words', 'person-slip', 'dialogue-tag-punctuation']));
    });
    it('names exactly the rules a sheet cannot run', () => {
        expect(rulesNotRunFor(EMPTY_STYLE_SHEET).sort()).toEqual(['banned-words', 'dialogue-tag-punctuation', 'person-slip', 'spelling-variant', 'tense-slip']);
        const full = compileStyleSheet('s', { check_tense: 'past', check_person: 'third_omniscient', check_spelling: 'american', quote_marks: 'double', tag_punctuation: 'inside', avoided_words: ['x'] });
        expect(rulesNotRunFor(full)).toEqual([]);
        expect(rulesNotRunFor(compileStyleSheet('s', { check_person: 'first' }))).toContain('person-slip');
    });
    it('keys the same sheet the same, whatever order its lists were written in', () => {
        const a = compileStyleSheet('s', { avoided_words: ['b', 'a'], word_swaps: ['y → z', 'x → w'] });
        const b = compileStyleSheet('s', { avoided_words: ['a', 'b'], word_swaps: ['x → w', 'y → z'] });
        expect(canonicalSheet(a)).toBe(canonicalSheet(b));
    });
    it('normalises word items and refuses constructions', () => {
        expect(normaliseWordItem('  Don’t  ')).toBe("don't");
        expect(normaliseWordItem('one two three four five')).toBeNull();
        expect(normaliseWordItem('a, b')).toBeNull();
        expect(parseSwap('x'.repeat(200) + ' → y')).toBeNull();
    });
});

describe('the STYLE template carries the structured sheet', () => {
    const template = getTemplate('STYLE');
    const field = (key: string) => template.fields.find((f) => f.key === key);
    it('declares each check setting as a choice of exactly the values the checks read', () => {
        const values = (key: string) => {
            const f = field(key);
            return f && f.type === 'choice' ? f.options.map((o) => o.value) : null;
        };
        expect(values('check_tense')).toEqual([...STYLE_TENSES]);
        expect(values('check_person')).toEqual([...STYLE_PERSONS]);
        expect(values('check_spelling')).toEqual([...STYLE_SPELLINGS]);
        expect(values('quote_marks')).toEqual([...STYLE_QUOTE_MARKS]);
        expect(values('tag_punctuation')).toEqual([...STYLE_TAG_PUNCTUATION]);
        expect(field('word_swaps')?.type).toBe('list');
        expect(field('avoided_words')?.type).toBe('list');
    });
    it('stores a swap item as written (the list type keeps the arrow)', () => {
        const f = field('word_swaps')!;
        const r = normaliseFieldValue(f, ['utilise → use']);
        expect(r.ok && r.value).toEqual(['utilise → use']);
    });
    it('relates a character to the sheet with voice notes (declared on CHARACTER, the earlier kind)', () => {
        const rel = getTemplate('CHARACTER').relationTypes.find((r) => r.key === 'voiced_against');
        expect(rel?.targetKinds).toEqual(['STYLE']);
        expect(rel?.fields.map((f) => f.key)).toEqual(['voice_departures', 'voice_words']);
    });
});
