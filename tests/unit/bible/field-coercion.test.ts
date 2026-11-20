/**
 * A field whose template type changed since a bundle was written (issue #27,
 * item 8): a lossless coercion, or FIELD_TYPE_CHANGED — never a silent loss.
 */
import { coerceImportedFieldValue } from '@/lib/bible/field-coercion';
import type { FieldDef } from '@/lib/bible/template-schema';

const def = (type: FieldDef['type']): FieldDef => ({ key: 'k', label: 'K', type, order: 1, ...(type === 'choice' ? { options: [{ value: '3', label: 'Three' }, { value: 'north', label: 'North' }] } : {}) }) as unknown as FieldDef;

describe('coerceImportedFieldValue', () => {
    it('leaves a value already in the field’s shape untouched (a current export imports byte-identically)', () => {
        expect(coerceImportedFieldValue(def('text'), 'plain')).toEqual({ ok: true, value: 'plain', coerced: false });
        expect(coerceImportedFieldValue(def('richtext'), '<p>Hi</p>')).toEqual({ ok: true, value: '<p>Hi</p>', coerced: false });
        expect(coerceImportedFieldValue(def('list'), ['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'], coerced: false });
        expect(coerceImportedFieldValue(def('scale'), 4)).toEqual({ ok: true, value: 4, coerced: false });
    });

    it('coerces only where nothing is lost', () => {
        expect(coerceImportedFieldValue(def('list'), 'one')).toEqual({ ok: true, value: ['one'], coerced: true });
        expect(coerceImportedFieldValue(def('text'), ['only'])).toEqual({ ok: true, value: 'only', coerced: true });
        expect(coerceImportedFieldValue(def('text'), 3)).toEqual({ ok: true, value: '3', coerced: true });
        expect(coerceImportedFieldValue(def('richtext'), 'a < b')).toEqual({ ok: true, value: '<p>a &lt; b</p>', coerced: true });
        expect(coerceImportedFieldValue(def('richtext'), ['x', 'y'])).toEqual({ ok: true, value: '<p>x</p><p>y</p>', coerced: true });
        expect(coerceImportedFieldValue(def('scale'), ' 2 ')).toEqual({ ok: true, value: 2, coerced: true });
        expect(coerceImportedFieldValue(def('choice'), ['north'])).toEqual({ ok: true, value: 'north', coerced: true });
        expect(coerceImportedFieldValue(def('choice'), 3)).toEqual({ ok: true, value: '3', coerced: true });
    });

    it('refuses FIELD_TYPE_CHANGED where coercion would drop, invent or guess', () => {
        const refused = { ok: false, reason: 'FIELD_TYPE_CHANGED' };
        expect(coerceImportedFieldValue(def('text'), '<p>rich</p>')).toEqual(refused); // markup would be dropped
        expect(coerceImportedFieldValue(def('text'), ['a', 'b'])).toEqual(refused); // a separator would be invented
        expect(coerceImportedFieldValue(def('list'), '<p>rich</p>')).toEqual(refused);
        expect(coerceImportedFieldValue(def('scale'), 'quite strong')).toEqual(refused); // a number would be guessed
        expect(coerceImportedFieldValue(def('scale'), '7')).toEqual(refused);
        expect(coerceImportedFieldValue(def('scale'), ['3'])).toEqual(refused);
        expect(coerceImportedFieldValue(def('choice'), ['a', 'b'])).toEqual(refused);
    });

    it('passes a value of no field shape through, for the validation to refuse as it always has', () => {
        expect(coerceImportedFieldValue(def('text'), { a: 1 })).toEqual({ ok: true, value: { a: 1 }, coerced: false });
    });

    it('reads a value of many tag openings and no closing bracket in linear time (a bundle file is up to 2 MiB)', () => {
        // With the old `[^>]*` this took tens of seconds (quadratic); it must take milliseconds.
        const hostile = '<p '.repeat(100_000);
        const t0 = performance.now();
        expect(coerceImportedFieldValue(def('text'), hostile)).toEqual({ ok: true, value: hostile, coerced: false });
        expect(coerceImportedFieldValue(def('richtext'), hostile).ok).toBe(true);
        expect(performance.now() - t0).toBeLessThan(1_000);
    });
});
