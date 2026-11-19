/**
 * A field value is checked against its field's type and sanitised before it
 * is stored (src/lib/bible/field-values.ts), and an empty value clears.
 */
import { decodeFieldValue, encodeFieldValue, LIST_ITEMS_MAX, normaliseFieldValue, sameFieldValue, TEXT_MAX } from '@/lib/bible/field-values';
import { getFieldDef } from '@/lib/bible/templates';
import type { FieldDef } from '@/lib/bible/template-schema';

const field = (kind: Parameters<typeof getFieldDef>[0], key: string): FieldDef => {
    const def = getFieldDef(kind, key);
    if (!def) throw new Error(`no field ${kind}.${key}`);
    return def;
};

const text = field('CHARACTER', 'want');
const rich = field('CHARACTER', 'wound');
const list = field('CHARACTER', 'defining_traits');
const choice = field('CHARACTER', 'prominence');
const scale = field('CHARACTER', 'agency');

it('the fixtures are the types they claim', () => {
    expect([text.type, rich.type, list.type, choice.type, scale.type]).toEqual(['text', 'richtext', 'list', 'choice', 'scale']);
});

describe('text', () => {
    it('keeps the words, strips every tag, decodes entities, collapses to one line', () => {
        expect(normaliseFieldValue(text, '  To <b>win</b> back\nthe  <script>alert(1)</script>farm &amp; mill ')).toEqual({
            ok: true,
            value: 'To win back the farm & mill',
        });
    });

    it('does not let an entity-encoded tag through', () => {
        const r = normaliseFieldValue(text, '&lt;img src=x onerror=alert(1)&gt;hello');
        expect(r.ok && String(r.value)).not.toMatch(/<img|onerror/);
    });

    it('refuses a non-string and an over-long value (measured after sanitising)', () => {
        expect(normaliseFieldValue(text, 3)).toEqual({ ok: false, reason: 'NOT_A_STRING' });
        expect(normaliseFieldValue(text, 'x'.repeat(TEXT_MAX + 1))).toEqual({ ok: false, reason: 'TOO_LONG' });
        expect(normaliseFieldValue(text, `<b>${'x'.repeat(TEXT_MAX)}</b>`)).toEqual({ ok: true, value: 'x'.repeat(TEXT_MAX) });
    });

    it('an empty or all-markup value clears the field', () => {
        expect(normaliseFieldValue(text, '   ')).toEqual({ ok: true, value: null });
        expect(normaliseFieldValue(text, '<script>alert(1)</script>')).toEqual({ ok: true, value: null });
        expect(normaliseFieldValue(text, null)).toEqual({ ok: true, value: null });
    });
});

describe('richtext', () => {
    it('keeps formatting, drops scripts, handlers and javascript: links', () => {
        const r = normaliseFieldValue(rich, '<p onclick="x()">She <strong>left</strong></p><script>steal()</script><a href="javascript:alert(1)">l</a>');
        expect(r.ok).toBe(true);
        const v = String(r.ok && r.value);
        expect(v).toContain('<strong>left</strong>');
        expect(v).not.toMatch(/script|onclick|javascript:/);
    });

    it('rich text with no words left clears the field', () => {
        expect(normaliseFieldValue(rich, '<p></p><p> </p>')).toEqual({ ok: true, value: null });
    });
});

describe('list', () => {
    it('is an array of sanitised, non-empty strings', () => {
        expect(normaliseFieldValue(list, ['<i>stubborn</i>', '  ', 'loyal'])).toEqual({ ok: true, value: ['stubborn', 'loyal'] });
    });

    it('refuses a non-array, a non-string item and too many items; an empty list clears', () => {
        expect(normaliseFieldValue(list, 'stubborn')).toEqual({ ok: false, reason: 'NOT_A_LIST' });
        expect(normaliseFieldValue(list, ['ok', 3])).toEqual({ ok: false, reason: 'ITEM_NOT_A_STRING' });
        expect(normaliseFieldValue(list, Array.from({ length: LIST_ITEMS_MAX + 1 }, () => 'x'))).toEqual({ ok: false, reason: 'TOO_MANY_ITEMS' });
        expect(normaliseFieldValue(list, [])).toEqual({ ok: true, value: null });
    });
});

describe('choice', () => {
    it("accepts one of the template's option values and nothing else", () => {
        const offered = choice.type === 'choice' ? choice.options[0].value : '';
        expect(normaliseFieldValue(choice, offered)).toEqual({ ok: true, value: offered });
        expect(normaliseFieldValue(choice, 'not_an_option')).toEqual({ ok: false, reason: 'NOT_AN_OPTION' });
        // The option's LABEL is not its value.
        const label = choice.type === 'choice' ? choice.options[0].label : '';
        expect(normaliseFieldValue(choice, label)).toEqual({ ok: false, reason: 'NOT_AN_OPTION' });
    });
});

describe('scale', () => {
    it('is a whole number from 1 to 5', () => {
        expect(normaliseFieldValue(scale, 1)).toEqual({ ok: true, value: 1 });
        expect(normaliseFieldValue(scale, 5)).toEqual({ ok: true, value: 5 });
        expect(normaliseFieldValue(scale, 0)).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
        expect(normaliseFieldValue(scale, 6)).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
        expect(normaliseFieldValue(scale, 2.5)).toEqual({ ok: false, reason: 'NOT_A_WHOLE_NUMBER' });
        expect(normaliseFieldValue(scale, '3')).toEqual({ ok: false, reason: 'NOT_A_WHOLE_NUMBER' });
    });
});

describe('storage form', () => {
    it.each([['a line'], [3], [['a', 'b']], ['"quoted" & <tagged>']])('%p round-trips through JSON', (value) => {
        expect(decodeFieldValue(encodeFieldValue(value as never))).toEqual(value);
    });

    it('compares lists by item', () => {
        expect(sameFieldValue(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(sameFieldValue(['a', 'b'], ['b', 'a'])).toBe(false);
        expect(sameFieldValue('a', null)).toBe(false);
    });
});
