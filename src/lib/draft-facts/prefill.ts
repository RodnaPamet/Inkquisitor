/**
 * "UPDATE THE BIBLE" — the field opened PREFILLED with the draft's value (Phase 5.3, D35 item 3). Pure and
 * client-safe: what the update sheet shows in the field before the author edits it. NOTHING IS SAVED HERE: the author
 * edits the prefilled value and saves it themselves, through the ordinary versioned save (rule 1).
 *
 *   text       the bible's value (the object the bible fact states) replaced, at its first place in the field (inside
 *              the bible fact's own words when they are found), by the draft's — REPLACED; with no value to swap, the
 *              draft's sentence is added on a line of its own (or is the whole value of an empty field) — APPENDED
 *   richtext   the same over the field's TEXT only (never inside a tag), the values written as text; the draft's
 *              sentence added as a paragraph of its own — the save sanitises the result like any other edit
 *   list       the item holding the bible's value replaced by the draft's, else the draft's value added
 *   choice, scale   the field as it stands (UNCHANGED): the author picks; the draft's sentence is shown beside it
 */

export interface PrefillInput {
    readonly fieldType: string;
    readonly current: unknown;
    /** The bible fact's quote (its words in the entry) and the value it states. */
    readonly bibleQuote: string;
    readonly bibleObject: string | null;
    /** The draft fact's value and its sentence (the scene's own words). */
    readonly draftObject: string | null;
    readonly draftQuote: string;
}

export interface PrefillResult {
    readonly value: unknown;
    readonly basis: 'REPLACED' | 'APPENDED' | 'UNCHANGED';
}

/** The first occurrence of `needle` in `hay`, case-insensitively, at or after `from`; -1 when none. */
function indexOfFolded(hay: string, needle: string, from = 0): number {
    if (needle === '') return -1;
    return hay.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/** `value` with the bible's value swapped for the draft's at its first place (inside the bible's quote when found), or null. */
export function swapInText(value: string, bibleQuote: string, bibleObject: string, draftObject: string): string | null {
    const quoteAt = indexOfFolded(value, bibleQuote);
    let at = quoteAt >= 0 ? indexOfFolded(value, bibleObject, quoteAt) : -1;
    if (at < 0 || (quoteAt >= 0 && at >= quoteAt + bibleQuote.length)) at = indexOfFolded(value, bibleObject);
    if (at < 0) return null;
    return value.slice(0, at) + draftObject + value.slice(at + bibleObject.length);
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** An HTML value with the bible's value swapped for the draft's in its first TEXT run that holds it (never inside a tag), or null. */
export function swapInHtml(html: string, bibleObject: string, draftObject: string): string | null {
    const parts = html.split(/(<[^>]*>)/);
    const needle = escapeHtml(bibleObject);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.startsWith('<')) continue;
        const at = indexOfFolded(part, needle);
        if (at < 0) continue;
        parts[i] = part.slice(0, at) + escapeHtml(draftObject) + part.slice(at + needle.length);
        return parts.join('');
    }
    return null;
}

export function draftPrefill(input: PrefillInput): PrefillResult {
    const bible = input.bibleObject?.trim() ?? '';
    const draft = input.draftObject?.trim() ?? '';
    const canSwap = bible !== '' && draft !== '' && bible.toLowerCase() !== draft.toLowerCase();
    switch (input.fieldType) {
        case 'text': {
            const current = typeof input.current === 'string' ? input.current : '';
            const swapped = canSwap ? swapInText(current, input.bibleQuote, bible, draft) : null;
            if (swapped !== null) return { value: swapped, basis: 'REPLACED' };
            return { value: current.trim() === '' ? input.draftQuote : `${current}\n${input.draftQuote}`, basis: 'APPENDED' };
        }
        case 'richtext': {
            const current = typeof input.current === 'string' ? input.current : '';
            const swapped = canSwap ? swapInHtml(current, bible, draft) : null;
            if (swapped !== null) return { value: swapped, basis: 'REPLACED' };
            return { value: `${current}<p>${escapeHtml(input.draftQuote)}</p>`, basis: 'APPENDED' };
        }
        case 'list': {
            const current = Array.isArray(input.current) ? input.current.filter((x): x is string => typeof x === 'string') : [];
            if (canSwap) {
                const i = current.findIndex((item) => indexOfFolded(item, bible) >= 0);
                if (i >= 0) return { value: current.map((item, j) => (j === i ? (swapInText(item, item, bible, draft) ?? item) : item)), basis: 'REPLACED' };
            }
            const added = draft !== '' ? draft : input.draftQuote;
            return { value: [...current, added], basis: 'APPENDED' };
        }
        default:
            return { value: input.current ?? null, basis: 'UNCHANGED' };
    }
}
