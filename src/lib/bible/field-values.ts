/**
 * A bible field's value, checked against the field's type and sanitised,
 * before it is stored (Phase 1.1).
 *
 *   text       one line of plain text           sanitizePlainText, ≤ TEXT_MAX
 *   richtext   the editor's HTML                sanitizeRichTextHtml, ≤ RICHTEXT_MAX
 *   list       an array of plain-text items     each sanitizePlainText, ≤ LIST_ITEMS_MAX items of ≤ LIST_ITEM_MAX
 *   choice     one option's `value`             must be one the template offers
 *   scale      a whole number 1..5              nothing else
 *
 * An empty value — `null`, a blank string, a list of blank items, rich text
 * with no text left once sanitised — CLEARS the field: the caller deletes its
 * row rather than storing an empty one, so "filled" always means "has a row".
 *
 * Sanitising happens HERE, at the boundary every write path crosses
 * (`normaliseFieldValue` is called by the element usecases for a manual save
 * and a restore alike), so no stored value skips it. A value the sanitiser
 * empties (`<script>…</script>` alone) clears the field rather than storing
 * nothing in particular.
 *
 * Stored as JSON (`encodeFieldValue`), so the type survives the round trip
 * through the encrypted string column.
 */
import { sanitizePlainText, sanitizeRichTextHtml } from '@/lib/security/sanitize';
import type { FieldDef } from './template-schema';
import { plainLine } from './text';

export const TEXT_MAX = 2_000;
export const RICHTEXT_MAX = 100_000;
export const LIST_ITEMS_MAX = 50;
export const LIST_ITEM_MAX = 500;
export const SCALE_MIN = 1;
export const SCALE_MAX = 5;

export type FieldValue = string | number | string[];

export type FieldValueResult = { ok: true; value: FieldValue | null } | { ok: false; reason: FieldValueRefusal };

export type FieldValueRefusal =
    | 'NOT_A_STRING'
    | 'TOO_LONG'
    | 'NOT_A_LIST'
    | 'TOO_MANY_ITEMS'
    | 'ITEM_NOT_A_STRING'
    | 'ITEM_TOO_LONG'
    | 'NOT_AN_OPTION'
    | 'NOT_A_WHOLE_NUMBER'
    | 'OUT_OF_RANGE';

const refuse = (reason: FieldValueRefusal): FieldValueResult => ({ ok: false, reason });

/** Is there any text in this HTML once the tags are gone? */
function hasText(html: string): boolean {
    return sanitizePlainText(html).trim().length > 0;
}

/**
 * The value to store for `field`, or why it is refused. Length limits apply to
 * the SANITISED value, the one stored; an input over the limit only because
 * of markup the sanitiser drops is accepted.
 */
export function normaliseFieldValue(field: FieldDef, input: unknown): FieldValueResult {
    if (input === null || input === undefined) return { ok: true, value: null };
    switch (field.type) {
        case 'text': {
            if (typeof input !== 'string') return refuse('NOT_A_STRING');
            const value = plainLine(input);
            if (value.length > TEXT_MAX) return refuse('TOO_LONG');
            return { ok: true, value: value.length === 0 ? null : value };
        }
        case 'richtext': {
            if (typeof input !== 'string') return refuse('NOT_A_STRING');
            const value = sanitizeRichTextHtml(input).trim();
            if (value.length > RICHTEXT_MAX) return refuse('TOO_LONG');
            return { ok: true, value: hasText(value) ? value : null };
        }
        case 'list': {
            if (!Array.isArray(input)) return refuse('NOT_A_LIST');
            if (input.length > LIST_ITEMS_MAX) return refuse('TOO_MANY_ITEMS');
            const items: string[] = [];
            for (const item of input) {
                if (typeof item !== 'string') return refuse('ITEM_NOT_A_STRING');
                const value = plainLine(item);
                if (value.length > LIST_ITEM_MAX) return refuse('ITEM_TOO_LONG');
                if (value.length > 0) items.push(value);
            }
            return { ok: true, value: items.length === 0 ? null : items };
        }
        case 'choice': {
            if (typeof input !== 'string') return refuse('NOT_A_STRING');
            if (input === '') return { ok: true, value: null };
            return field.options.some((o) => o.value === input) ? { ok: true, value: input } : refuse('NOT_AN_OPTION');
        }
        case 'scale': {
            if (typeof input !== 'number' || !Number.isInteger(input)) return refuse('NOT_A_WHOLE_NUMBER');
            if (input < SCALE_MIN || input > SCALE_MAX) return refuse('OUT_OF_RANGE');
            return { ok: true, value: input };
        }
    }
}

/** The stored form: JSON of the normalised value. */
export function encodeFieldValue(value: FieldValue): string {
    return JSON.stringify(value);
}

/** The stored form back to a value; a row that does not parse reads as its raw text rather than failing the read. */
export function decodeFieldValue(stored: string): FieldValue {
    try {
        const parsed: unknown = JSON.parse(stored);
        if (typeof parsed === 'string' || typeof parsed === 'number') return parsed;
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed as string[];
    } catch {
        // fall through
    }
    return stored;
}

/** Two values the same? (lists compared item by item) */
export function sameFieldValue(a: FieldValue | null, b: FieldValue | null): boolean {
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
    return a === b;
}
