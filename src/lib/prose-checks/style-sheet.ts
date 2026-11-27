/**
 * THE STYLE SHEET, compiled (Phase 5.2, D34): a book's STYLE element's
 * structured fields turned into the settings the checks run under. Pure.
 *
 * WHICH ELEMENT. A book's style sheet is its STYLE element whose span is the
 * whole book (`style_scope` = `whole_book`); failing one, a STYLE element with
 * no span stated; the oldest of either (by creation, then id). A STYLE element
 * scoped to one part, viewpoint, time frame or to quoted documents is NOT
 * applied to the whole manuscript in 5.2: its tense or spelling would be held
 * against scenes it does not govern. No sheet: the rules that need one do not
 * run, and the check says which (`rulesNotRun`).
 *
 * WHAT IT READS (the template's fields, `src/lib/bible/templates/style.json`):
 *   check_spelling   British / American / Canadian / Australian spelling
 *   check_tense      past / present: the tense the narration keeps
 *   check_person     first / second / third limited / third omniscient
 *   quote_marks      how speech is marked: the dialogue detector's input
 *   tag_punctuation  a comma before a speech tag inside or outside the mark
 *   avoided_words    each item that is a word or short phrase (letters,
 *                    apostrophes, hyphens and spaces; at most four words) is
 *                    flagged; longer items describe constructions and are not
 *                    checkable (counted in `ignoredItems`)
 *   word_swaps       each item "word → replacement" (also "->" or "=>"): the
 *                    word is flagged and the replacement offered for the author
 *                    to accept; an item that does not parse is counted too
 *
 * The prose fields (tense, diction, rhythm, dialogue conventions, …) and the
 * per-character voice notes (a CHARACTER's `voiced_against` relation fields)
 * are for the author and the interview: no deterministic check can read them.
 */
import type { FieldValue } from '@/lib/bible/field-values';
import {
    STYLE_PERSONS,
    STYLE_QUOTE_MARKS,
    STYLE_SPELLINGS,
    STYLE_TAG_PUNCTUATION,
    STYLE_TENSES,
    STYLE_WORD_ITEM_MAX_WORDS,
    type StylePerson,
    type StyleQuoteMarks,
    type StyleSpelling,
    type StyleTagPunctuation,
    type StyleTense,
} from './vocabulary';

export interface StyleSwap {
    /** The word or phrase to flag, lower case, single-spaced. */
    from: string;
    /** The replacement offered, as the author wrote it. */
    to: string;
}

export interface CompiledStyleSheet {
    elementId: string | null;
    spelling: StyleSpelling | null;
    tense: StyleTense | null;
    person: StylePerson | null;
    quoteMarks: StyleQuoteMarks | null;
    tagPunctuation: StyleTagPunctuation | null;
    /** Avoided words and phrases, lower case, single-spaced, deduplicated (a swap's word is in `swaps` instead). */
    banned: string[];
    swaps: StyleSwap[];
    /** Word-list items that could not be checked (constructions, unparsed swaps). */
    ignoredItems: number;
}

/** The sheet of a book with no style sheet: nothing set, so only the rules that need nothing run. */
export const EMPTY_STYLE_SHEET: CompiledStyleSheet = Object.freeze({
    elementId: null,
    spelling: null,
    tense: null,
    person: null,
    quoteMarks: null,
    tagPunctuation: null,
    banned: [],
    swaps: [],
    ignoredItems: 0,
}) as CompiledStyleSheet;

export interface StyleElementRow {
    id: string;
    createdAt: Date;
    fields: Readonly<Record<string, FieldValue | undefined>>;
}

/** The element a book's style sheet is read from (the rule in the header), or null. */
export function pickStyleSheetElement<T extends StyleElementRow>(elements: readonly T[]): T | null {
    const order = (a: T, b: T) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const whole = elements.filter((e) => e.fields.style_scope === 'whole_book').sort(order);
    if (whole.length > 0) return whole[0];
    const unscoped = elements.filter((e) => e.fields.style_scope === undefined || e.fields.style_scope === null).sort(order);
    return unscoped[0] ?? null;
}

function choice<T extends string>(value: FieldValue | undefined, options: readonly T[]): T | null {
    return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : null;
}

/** A word or short phrase: letters (any script), apostrophes, hyphens, single spaces; one to four words. */
const CHECKABLE_ITEM = /^[\p{L}\p{M}'’-]+(?: [\p{L}\p{M}'’-]+){0,3}$/u;

/** An item normalised for matching: trimmed, inner spaces one space, curly apostrophes straight, lower case. */
export function normaliseWordItem(item: string): string | null {
    if (item.length > 160) return null;
    const s = item.trim().split(/\s+/).join(' ').replace(/’/g, "'").toLowerCase();
    if (s.length === 0 || s.length > 64 || !CHECKABLE_ITEM.test(s)) return null;
    if (s.split(' ').length > STYLE_WORD_ITEM_MAX_WORDS) return null;
    return s;
}

/** "from → to" (or "->", "=>"): one separator, both sides checkable words or short phrases. */
export function parseSwap(item: string): StyleSwap | null {
    if (item.length > 160) return null;
    // Exactly one separator, found by search (no pattern over the item).
    const seps = ['→', '->', '=>'].flatMap((sep) => {
        const at: Array<[number, number]> = [];
        for (let i = item.indexOf(sep); i !== -1; i = item.indexOf(sep, i + sep.length)) at.push([i, sep.length]);
        return at;
    });
    if (seps.length !== 1) return null;
    const [at, len] = seps[0];
    const from = normaliseWordItem(item.slice(0, at));
    const to = item.slice(at + len).trim().split(/\s+/).join(' ');
    if (!from || normaliseWordItem(to) === null) return null;
    return { from, to };
}

/** Compile the element's stored field values (decoded) into a sheet. */
export function compileStyleSheet(elementId: string | null, fields: Readonly<Record<string, FieldValue | undefined>>): CompiledStyleSheet {
    let ignored = 0;
    const swaps: StyleSwap[] = [];
    const swapFrom = new Set<string>();
    const rawSwaps = Array.isArray(fields.word_swaps) ? fields.word_swaps : [];
    for (const item of rawSwaps) {
        const swap = typeof item === 'string' ? parseSwap(item) : null;
        if (!swap) {
            ignored++;
            continue;
        }
        if (swapFrom.has(swap.from)) continue;
        swapFrom.add(swap.from);
        swaps.push(swap);
    }
    const banned: string[] = [];
    const rawBanned = Array.isArray(fields.avoided_words) ? fields.avoided_words : [];
    for (const item of rawBanned) {
        const w = typeof item === 'string' ? normaliseWordItem(item) : null;
        if (!w) {
            ignored++;
            continue;
        }
        if (!swapFrom.has(w) && !banned.includes(w)) banned.push(w);
    }
    return {
        elementId,
        spelling: choice(fields.check_spelling, STYLE_SPELLINGS),
        tense: choice(fields.check_tense, STYLE_TENSES),
        person: choice(fields.check_person, STYLE_PERSONS),
        quoteMarks: choice(fields.quote_marks, STYLE_QUOTE_MARKS),
        tagPunctuation: choice(fields.tag_punctuation, STYLE_TAG_PUNCTUATION),
        banned: banned.sort(),
        swaps: swaps.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
        ignoredItems: ignored,
    };
}

/** The sheet as canonical JSON: what the check's configuration key is computed over. */
export function canonicalSheet(sheet: CompiledStyleSheet): string {
    return JSON.stringify([sheet.elementId, sheet.spelling, sheet.tense, sheet.person, sheet.quoteMarks, sheet.tagPunctuation, sheet.banned, sheet.swaps.map((s) => [s.from, s.to])]);
}
