/**
 * WHEN A TEMPLATE CHANGES A FIELD'S TYPE, WHAT HAPPENS TO AN OLDER EXPORT ON
 * RE-IMPORT (issue #27, item 8). Decided here: a LOSSLESS coercion where one
 * exists, a named refusal otherwise — never a silent loss.
 *
 * A bundle stores each value in its field's shape at export time (a string, a
 * list of strings, a scale's number; rich text as HTML). If the field's type
 * has changed since, the value arrives in the old shape. The import then
 * applies this table, BEFORE the 1.1 validation (`normaliseFieldValue`), which
 * still judges the result exactly as a manual save would:
 *
 *   to \\ from     text            list               richtext        scale (number)
 *   text           —               one item only      REFUSED         its digits
 *   richtext       one paragraph   a paragraph each   —               one paragraph
 *   list           one item        —                  REFUSED         one item
 *   choice         as given *      one item only *    REFUSED         as text *
 *   scale          "1"…"5" only    REFUSED            REFUSED         —
 *
 *   * a choice still has to be one of the options; anything else is refused
 *     NOT_AN_OPTION by the validation, as a manual save would be.
 *
 * REFUSED is `FIELD_TYPE_CHANGED`, naming the field: rich text into a plain
 * field would drop its markup, several list items into one value would invent
 * a separator, words into a number would guess. The author fixes the file or
 * enters the value again. A value already in the field's current shape is
 * never touched, so a current export imports byte-identically (1.3).
 *
 * A HTML-looking string meant for a plain field is read as rich text: a stored
 * plain value is sanitised to text on every save, so an export of one carries
 * no tags, and tags in a plain field's value mean the field was rich text when
 * the bundle was written.
 */
import { escapeHtml } from './snapshot-text';
import type { FieldDef } from './template-schema';

export type CoercionResult = { ok: true; value: unknown; coerced: boolean } | { ok: false; reason: 'FIELD_TYPE_CHANGED' };

const HTML_TAG = /<\/?(p|br|ul|ol|li|strong|em|b|i|u|a|h[1-6]|blockquote|code|pre|span|div)\b[^>]*>/i;
const SCALE_TEXT = /^[1-5]$/;

const paragraph = (s: string) => `<p>${escapeHtml(s)}</p>`;
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const changed: CoercionResult = { ok: false, reason: 'FIELD_TYPE_CHANGED' };
const as = (value: unknown): CoercionResult => ({ ok: true, value, coerced: true });
const keep = (value: unknown): CoercionResult => ({ ok: true, value, coerced: false });

/** The value an imported field takes under its CURRENT type (see the table). Values of no field shape pass through for the validation to refuse. */
export function coerceImportedFieldValue(def: FieldDef, value: unknown): CoercionResult {
    if (value === null || value === undefined) return keep(value);
    const isString = typeof value === 'string';
    const isNumber = typeof value === 'number';
    const isList = isStringList(value);
    if (!isString && !isNumber && !isList) return keep(value);
    switch (def.type) {
        case 'text':
            if (isString) return HTML_TAG.test(value) ? changed : keep(value);
            if (isNumber) return as(String(value));
            return value.length === 1 && !HTML_TAG.test(value[0]) ? as(value[0]) : value.length === 0 ? as(null) : changed;
        case 'richtext':
            if (isString) return HTML_TAG.test(value) ? keep(value) : as(paragraph(value));
            if (isNumber) return as(paragraph(String(value)));
            return as(value.map(paragraph).join(''));
        case 'list':
            if (isList) return keep(value);
            if (isNumber) return as([String(value)]);
            return HTML_TAG.test(value) ? changed : as(value.trim() === '' ? [] : [value]);
        case 'choice':
            if (isString) return HTML_TAG.test(value) ? changed : keep(value);
            if (isNumber) return as(String(value));
            return value.length === 1 ? as(value[0]) : value.length === 0 ? as(null) : changed;
        case 'scale':
            if (isNumber) return keep(value);
            if (isString && SCALE_TEXT.test(value.trim())) return as(Number(value.trim()));
            return changed;
    }
}
