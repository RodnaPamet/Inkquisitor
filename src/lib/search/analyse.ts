/**
 * Word search's text analysis (Phase 3.4, decision D21): how a plain text
 * becomes the terms it can be found by, and how a query word becomes the
 * terms it looks for. Pure; used by the index (documents) and the query
 * parser alike, so the two can never disagree.
 *
 * WORDS. A text is split with `Intl.Segmenter` (granularity `word`, the
 * Unicode word-boundary rules); a segment is a word when it `isWordLike`.
 * Every word keeps its offsets into the plain text, for highlighting.
 *
 * NORMALISATION of a word (`foldWord`): NFKC (full-width and ligature forms
 * become plain letters), every apostrophe spelled `'` (curly, modifier
 * letter, prime, full-width, grave and acute accents used as apostrophes),
 * invisible format characters removed, lower case, diacritics folded
 * (café → cafe; ß → ss, æ → ae, œ → oe, ø → o, ł → l, đ and ð → d, þ → th,
 * dotless ı → i; the Greek final sigma read as sigma), and a possessive stripped (Wren's → wren, the authors' →
 * authors).
 *
 * TWO TERMS PER WORD, and a third for a name:
 *   surface  the folded word: a "quoted phrase" matches surface forms in sequence
 *   stem     the folded word through the irregular table (`irregular.ts`) and
 *            Porter2 (`porter2.ts`): an unquoted query word matches by stem
 *   exact    the word with its case kept (diacritics and apostrophes folded,
 *            possessive stripped), only for a word that begins with a capital
 *            AND does not start a sentence — in a name-like source (a name, a
 *            label, the title) every capitalised word. A capitalised query
 *            word ("Hope") that meets its exact form ranks above the same word
 *            in lower case: a ranking signal, never a filter (`rank.ts`).
 *
 * LANGUAGE. English (decision D12) stems; any other language matches
 * normalised surface forms with no stemming and no stop words
 * (`createAnalyzer('other')`). `Book` carries no language yet, so every book
 * is analysed as English (the 3.4 note).
 *
 * Each analyzer caches the folds and stems of the words it has met, for its
 * own life — one search request — and nothing else: nothing here outlives
 * the request that made it.
 */
import { lemmaOf, IRREGULAR_FORMS_VERSION } from './irregular';
import { porter2Stem, PORTER2_VERSION } from './porter2';

export type SearchLanguage = 'en' | 'other';

/** Moves whenever any term a text yields moves: the normaliser's own version, the stemmer's and the irregular table's. */
export const SEARCH_ANALYZER_VERSION = `analyse-1+${PORTER2_VERSION}+${IRREGULAR_FORMS_VERSION}`;

/** A word longer than this (a pasted URL, a run of letters) is matched by its surface form only. */
export const STEMMED_WORD_MAX_CHARS = 48;

/** Every spelling of an apostrophe a word may carry. */
const APOSTROPHES = /[‘’‛ʼʻ′＇`´]/g;
/** Invisible format characters (soft hyphen, zero-width joiners, bidi controls, tags). */
const FORMAT_CHARS = /\p{Cf}/gu;
/** Combining marks, left behind by NFD. */
const MARKS = /\p{M}/gu;
/** Letters that carry no combining mark to fold, mapped by hand. */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
    ß: 'ss',
    ẞ: 'SS',
    æ: 'ae',
    Æ: 'AE',
    œ: 'oe',
    Œ: 'OE',
    ø: 'o',
    Ø: 'O',
    ł: 'l',
    Ł: 'L',
    đ: 'd',
    Đ: 'D',
    ð: 'd',
    Ð: 'D',
    þ: 'th',
    Þ: 'TH',
    ı: 'i',
};
const LETTER_FOLD_RE = new RegExp(`[${Object.keys(LETTER_FOLDS).join('')}]`, 'gu');
const FINAL_SIGMA = /\u03C2/g;
/** A text of ASCII characters only (the common case, which every fold leaves alone). */
const ASCII = /^[\u0000-\u007F]*$/;

/** The character-level folds every term and every folded text share: NFKC, apostrophes, format characters, diacritics, letter folds. */
function foldCharacters(text: string): string {
    // ASCII has nothing to normalise, no format character, no mark and no letter fold: only the grave accent as an apostrophe.
    if (ASCII.test(text)) return text.includes('`') ? text.replaceAll('`', "'") : text;
    return text
        .normalize('NFKC')
        .replace(APOSTROPHES, "'")
        .replace(FORMAT_CHARS, '')
        .normalize('NFD')
        .replace(MARKS, '')
        .replace(LETTER_FOLD_RE, (c) => LETTER_FOLDS[c] ?? c)
        .normalize('NFC');
}

/** Lower case, with the Greek final sigma (whose form depends on what follows) read as sigma. */
function lowerCase(text: string): string {
    return text.toLowerCase().replace(FINAL_SIGMA, '\u03C3');
}

/** A word with its case kept: NFKC, apostrophes unified, format characters dropped, diacritics folded, possessive stripped. */
export function caseKeptForm(word: string): string {
    return stripPossessive(foldCharacters(word));
}

/** A word as its surface term: the case-kept form, lower-cased. */
export function foldWord(word: string): string {
    // Lower-case BEFORE the possessive strip too: "WREN'S" → "wren".
    return stripPossessive(lowerCase(foldCharacters(word)));
}

/**
 * A whole text folded as its words are (no possessive strip): every word's
 * surface form is a substring of its text's folded form, which is what lets
 * the ranking skip a source that cannot match (`rank.ts`).
 */
export function foldText(text: string): string {
    return lowerCase(foldCharacters(text));
}

function stripPossessive(word: string): string {
    let w = word;
    while (w.startsWith("'")) w = w.slice(1);
    if (w.endsWith("'s") || w.endsWith("'S")) w = w.slice(0, -2);
    while (w.endsWith("'")) w = w.slice(0, -1);
    return w;
}

/** Runs of letters and digits: a source's length for ranking, counted the same cheap way for every source. */
const WORD_RUN = /[\p{L}\p{M}\p{N}]+/gu;

/** How many words a text holds, as letter-or-digit runs (`rank.ts` normalises by it; the tokeniser is not needed to count). */
export function countWords(text: string): number {
    let n = 0;
    WORD_RUN.lastIndex = 0;
    while (WORD_RUN.exec(text) !== null) n++;
    return n;
}

/** Does the word begin with a capital letter (upper or title case)? */
export function isCapitalised(word: string): boolean {
    const first = word.replace(APOSTROPHES, "'").replace(/^'+/, '').charAt(0);
    return first !== '' && first !== first.toLowerCase() && first === first.toUpperCase();
}

/** English function words an unquoted query drops (unless it holds nothing else). Never applied to a document. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
    (
        'a an and are as at be been but by for from had has have he her his i if in into is it its me my no nor not of on or our she so ' +
        'than that the their them then there these they this those to too us was we were what when where which while who whom why will with would you your'
    ).split(' '),
);

export interface Token {
    /** Offsets into the plain text the token came from: `text.slice(start, end)` is the word as written. */
    start: number;
    end: number;
    surface: string;
    stem: string;
    /** The case-kept form, for a capitalised word not at a sentence start (or any capitalised word of a name-like source); else null. */
    exact: string | null;
}

/** How a source's capitals are read: in prose a sentence's first word is capitalised anyway; in a name every capital counts. */
export type CaseMode = 'prose' | 'name';

/** Characters that end a sentence, or open speech, so the next word's capital says nothing. */
const SENTENCE_BREAK = /[.!?…\n:;"“«]/;

export interface Analyzer {
    readonly language: SearchLanguage;
    /** The stem of a folded surface form (cached for the analyzer's life). */
    stemOf(surface: string): string;
    /** The tokens of a plain text. */
    tokenise(text: string, mode?: CaseMode): Token[];
    /** How many stems were computed rather than read from the cache: the counted work the performance test bounds. */
    readonly stemsComputed: number;
    /** How many words were segmented. */
    readonly wordsSegmented: number;
}

export function createAnalyzer(language: SearchLanguage = 'en'): Analyzer {
    const segmenter = new Intl.Segmenter(language === 'en' ? 'en' : undefined, { granularity: 'word' });
    const stems = new Map<string, string>();
    // A word as written → its surface form, and → its case-kept form: words repeat, folds are not free.
    const surfaces = new Map<string, string>();
    const caseKept = new Map<string, string>();
    let stemsComputed = 0;
    let wordsSegmented = 0;
    const stemOf = (surface: string): string => {
        if (language !== 'en' || surface.length > STEMMED_WORD_MAX_CHARS) return surface;
        let stem = stems.get(surface);
        if (stem === undefined) {
            stem = porter2Stem(lemmaOf(surface));
            stems.set(surface, stem);
            stemsComputed++;
        }
        return stem;
    };
    return {
        language,
        stemOf,
        get stemsComputed() {
            return stemsComputed;
        },
        get wordsSegmented() {
            return wordsSegmented;
        },
        tokenise(text: string, mode: CaseMode = 'prose'): Token[] {
            const out: Token[] = [];
            let sentenceStart = true;
            for (const seg of segmenter.segment(text)) {
                if (!seg.isWordLike) {
                    if (SENTENCE_BREAK.test(seg.segment)) sentenceStart = true;
                    continue;
                }
                wordsSegmented++;
                let surface = surfaces.get(seg.segment);
                if (surface === undefined) {
                    surface = foldWord(seg.segment);
                    surfaces.set(seg.segment, surface);
                }
                if (surface === '') continue;
                let exact: string | null = null;
                if ((mode === 'name' || !sentenceStart) && isCapitalised(seg.segment)) {
                    exact = caseKept.get(seg.segment) ?? null;
                    if (exact === null) {
                        exact = caseKeptForm(seg.segment);
                        caseKept.set(seg.segment, exact);
                    }
                }
                out.push({ start: seg.index, end: seg.index + seg.segment.length, surface, stem: stemOf(surface), exact });
                sentenceStart = false;
            }
            return out;
        },
    };
}
