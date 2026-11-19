/**
 * A field value's RAW size is bounded before anything sanitises it (Phase 1.1
 * review): the request schema refuses an oversized value or list, and
 * `normaliseFieldValue` holds each type to its own raw bound, so refusing a
 * megabytes-long value costs a length check, never a parse of the whole of it.
 */
jest.mock('@/lib/security/sanitize', () => {
    const actual = jest.requireActual<typeof import('@/lib/security/sanitize')>('@/lib/security/sanitize');
    return { ...actual, sanitizePlainText: jest.fn(actual.sanitizePlainText), sanitizeRichTextHtml: jest.fn(actual.sanitizeRichTextHtml) };
});

import { FieldsUpdateInput } from '@/app-layer/schemas/bible';
import { LIST_ITEM_MAX, LIST_ITEMS_MAX, normaliseFieldValue, RAW_INPUT_FACTOR, RICHTEXT_MAX, TEXT_MAX } from '@/lib/bible/field-values';
import { getFieldDef } from '@/lib/bible/templates';
import { sanitizePlainText, sanitizeRichTextHtml } from '@/lib/security/sanitize';

const plainSpy = sanitizePlainText as jest.MockedFunction<typeof sanitizePlainText>;
const richSpy = sanitizeRichTextHtml as jest.MockedFunction<typeof sanitizeRichTextHtml>;

const text = getFieldDef('CHARACTER', 'want')!;
const rich = getFieldDef('CHARACTER', 'wound')!;
const list = getFieldDef('CHARACTER', 'defining_traits')!;

beforeEach(() => {
    plainSpy.mockClear();
    richSpy.mockClear();
});

describe('the request schema', () => {
    const save = (value: unknown) => FieldsUpdateInput.safeParse({ fields: [{ key: 'wound', value }], baseVersion: 1 });

    it('refuses a string past the largest raw bound, and a list past its item count or item bound', () => {
        expect(save('x'.repeat(RICHTEXT_MAX * RAW_INPUT_FACTOR)).success).toBe(true);
        expect(save('x'.repeat(RICHTEXT_MAX * RAW_INPUT_FACTOR + 1)).success).toBe(false);
        expect(save('x'.repeat(5_000_000)).success).toBe(false);
        expect(save(Array.from({ length: LIST_ITEMS_MAX + 1 }, () => 'a')).success).toBe(false);
        expect(save(['x'.repeat(LIST_ITEM_MAX * RAW_INPUT_FACTOR + 1)]).success).toBe(false);
        expect(save(['x'.repeat(LIST_ITEM_MAX * RAW_INPUT_FACTOR)]).success).toBe(true);
    });
});

describe('normaliseFieldValue', () => {
    it('refuses an oversized rich-text value before the sanitiser runs', () => {
        expect(normaliseFieldValue(rich, `<p>${'x'.repeat(RICHTEXT_MAX * RAW_INPUT_FACTOR)}</p>`)).toEqual({ ok: false, reason: 'TOO_LONG' });
        expect(richSpy).not.toHaveBeenCalled();
        expect(plainSpy).not.toHaveBeenCalled();
    });

    it('refuses an oversized text value before the sanitiser runs', () => {
        expect(normaliseFieldValue(text, 'x'.repeat(TEXT_MAX * RAW_INPUT_FACTOR + 1))).toEqual({ ok: false, reason: 'TOO_LONG' });
        expect(plainSpy).not.toHaveBeenCalled();
    });

    it('refuses a list with an oversized item before sanitising ANY item', () => {
        const items = ['fine', 'also fine', 'x'.repeat(LIST_ITEM_MAX * RAW_INPUT_FACTOR + 1)];
        expect(normaliseFieldValue(list, items)).toEqual({ ok: false, reason: 'ITEM_TOO_LONG' });
        expect(normaliseFieldValue(list, ['fine', 7])).toEqual({ ok: false, reason: 'ITEM_NOT_A_STRING' });
        expect(plainSpy).not.toHaveBeenCalled();
    });

    it('still accepts a value over the stored bound only by markup the sanitiser drops', () => {
        const value = `<b>${'x'.repeat(TEXT_MAX)}</b>`.padEnd(TEXT_MAX + 100, ' ');
        expect(normaliseFieldValue(text, value)).toEqual({ ok: true, value: 'x'.repeat(TEXT_MAX) });
        expect(plainSpy).toHaveBeenCalled();
    });
});
