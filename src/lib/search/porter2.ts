/**
 * The Snowball English stemmer ("Porter2"), implemented in-house for word
 * search (Phase 3.4, decision D21). Pure, no dependency, no I/O.
 *
 * SOURCE. Written from the Snowball project's own definition of the
 * algorithm, `algorithms/english.sbl` at snowballstem/snowball commit
 * 06e1f74f7cf61ea8913c6269480b8d392c33dbae (BSD-3-Clause; credited in
 * NOTICE) — the program the description at
 * snowballstem.org/algorithms/english/stemmer.html is generated from. Every
 * routine below names the `.sbl` routine it implements, and keeps its order
 * and its tables. This is the CURRENT English algorithm, so besides the
 * classic Porter2 steps it carries the later revisions: the region prefixes
 * past / univers / later / emerg / organ / inter beside gener / commun /
 * arsen, the `-ing` exceptions (dying → die; inning, outing, canning,
 * herring, earring, evening kept), `-ogist` → `-og`, and `past` as a short
 * syllable.
 *
 * GOLDEN TEST. `tests/unit/search/porter2.test.ts` stems Snowball's own
 * English vocabulary (`voc.txt`, 42,649 words) and compares every stem with
 * Snowball's `output.txt` (snowballstem/snowball-data commit
 * 019921c3a41c2b70063ee3feb215a00c8e594597, under
 * `tests/fixtures/snowball/english/`). The version below is pinned to the
 * hash of that output: a change to this file that moves any stem fails the
 * pin until `PORTER2_VERSION` moves with it.
 *
 * INPUT. One word, already lower-cased with every apostrophe spelled `'`
 * (the search normaliser, `analyse.ts`, does both). The algorithm's
 * groupings are ASCII: any other letter is a non-vowel, as in every Snowball
 * build. Positions are counted in code points (the word is split into an
 * array), as Snowball counts characters.
 *
 * This is NOT the question engine's light stemmer (`stem()` in
 * `src/lib/interview/text.ts`), which grounding and deduplication depend on
 * and which must never change under them; the two never import each other
 * (`tests/guards/search-stemmer-separate.test.ts`).
 */

/** Moves whenever any stem this module produces moves; pinned to the golden output's hash by the golden test. */
export const PORTER2_VERSION = 'snowball-english-06e1f74f';

const V = new Set('aeiouy');
const V_WXY = new Set('aeiouywxY');
const AEO = new Set('aeo');
const VALID_LI = new Set('cdeghkmnrt');

/** `exception1`: whole words with a fixed stem (or kept as they are). */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
    ['skis', 'ski'],
    ['skies', 'sky'],
    ['idly', 'idl'],
    ['gently', 'gentl'],
    ['ugly', 'ugli'],
    ['early', 'earli'],
    ['only', 'onli'],
    ['singly', 'singl'],
    ['sky', 'sky'],
    ['news', 'news'],
    ['howe', 'howe'],
    ['atlas', 'atlas'],
    ['cosmos', 'cosmos'],
    ['bias', 'bias'],
    ['andes', 'andes'],
]);

/** `mark_regions`: words beginning with one of these have R1 after it. */
const REGION_PREFIXES = ['gener', 'commun', 'arsen', 'past', 'univers', 'later', 'emerg', 'organ', 'inter'];

type Word = string[];

function isV(c: string | undefined): boolean {
    return c !== undefined && V.has(c);
}

/** Does `w[0..end)` end with `s`? */
function endsWith(w: Word, end: number, s: string): boolean {
    if (s.length > end) return false;
    for (let i = 0; i < s.length; i++) if (w[end - s.length + i] !== s[i]) return false;
    return true;
}

/** The longest of `list` that `w[0..end)` ends with (Snowball's backward `among`), or null. */
function longestSuffix(w: Word, end: number, list: readonly string[]): string | null {
    let best: string | null = null;
    for (const s of list) if ((best === null || s.length > best.length) && endsWith(w, end, s)) best = s;
    return best;
}

function replaceEnd(w: Word, length: number, by: string): void {
    w.splice(w.length - length, length, ...by);
}

/** `shortv`, asked of `w[0..end)`. */
function shortv(w: Word, end: number): boolean {
    // non-v_WXY v non-v, at the end
    if (end >= 3 && !V_WXY.has(w[end - 1]) && isV(w[end - 2]) && !isV(w[end - 3])) return true;
    // non-v v, and nothing before them
    if (end === 2 && !isV(w[1]) && isV(w[0])) return true;
    // 'past' (pasted, pasting)
    return endsWith(w, end, 'past');
}

/** `prelude`: an initial apostrophe goes; an initial y, and every y after a vowel, becomes Y. */
function prelude(w: Word): boolean {
    let yFound = false;
    if (w[0] === "'") w.shift();
    if (w[0] === 'y') {
        w[0] = 'Y';
        yFound = true;
    }
    for (let i = 0; i + 1 < w.length; i++) {
        if (isV(w[i]) && w[i + 1] === 'y') {
            w[i + 1] = 'Y';
            yFound = true;
        }
    }
    return yFound;
}

/** `mark_regions`: R1 and R2 as indexes (the region is `[p, length)`). */
function markRegions(w: Word): { p1: number; p2: number } {
    const n = w.length;
    let p1 = n;
    let p2 = n;
    const afterVowelThenNonVowel = (from: number): number | null => {
        let i = from;
        while (i < n && !isV(w[i])) i++;
        if (i >= n) return null;
        i++;
        while (i < n && isV(w[i])) i++;
        if (i >= n) return null;
        return i + 1;
    };
    let prefix: string | null = null;
    for (const p of REGION_PREFIXES) if ((prefix === null || p.length > prefix.length) && w.length >= p.length && w.slice(0, p.length).join('') === p) prefix = p;
    let start: number | null;
    if (prefix !== null) start = prefix.length;
    else start = afterVowelThenNonVowel(0);
    if (start === null) return { p1, p2 };
    p1 = start;
    const second = afterVowelThenNonVowel(p1);
    if (second !== null) p2 = second;
    return { p1, p2 };
}

function step1a(w: Word): void {
    const apostrophe = longestSuffix(w, w.length, ["'s'", "'s", "'"]);
    if (apostrophe) w.length -= apostrophe.length;
    const s = longestSuffix(w, w.length, ['sses', 'ied', 'ies', 'ss', 'us', 's']);
    if (s === null) return;
    const start = w.length - s.length;
    switch (s) {
        case 'sses':
            replaceEnd(w, 4, 'ss');
            return;
        case 'ied':
        case 'ies':
            replaceEnd(w, 3, start >= 2 ? 'i' : 'ie');
            return;
        case 's': {
            // `next gopast v delete`: a vowel somewhere before the letter that precedes the s.
            if (start <= 0) return;
            for (let i = start - 2; i >= 0; i--) {
                if (isV(w[i])) {
                    w.length = start;
                    return;
                }
            }
            return;
        }
        default:
            return; // 'ss', 'us': kept
    }
}

function step1b(w: Word, p1: number): void {
    const s = longestSuffix(w, w.length, ['eedly', 'ingly', 'edly', 'eed', 'ing', 'ed']);
    if (s === null) return; // the '' entry: nothing to do
    const start = w.length - s.length;
    if (s === 'eed' || s === 'eedly') {
        if (start >= p1) {
            const prefix = w.slice(0, start).join('');
            if (prefix !== 'proc' && prefix !== 'exc' && prefix !== 'succ') replaceEnd(w, s.length, 'ee');
        }
        return;
    }
    if (s === 'ing') {
        const inner = longestSuffix(w, start, ['even', 'cann', 'inn', 'earr', 'herr', 'out', 'y']);
        if (inner === 'y') {
            // dying → die, lying → lie, tying → tie, vying → vie: one non-vowel, then y, then ing.
            if (start === 2 && !isV(w[0])) {
                replaceEnd(w, 4, 'ie');
                return;
            }
        } else if (inner !== null && start === inner.length) {
            return; // inning, outing, canning, herring, earring, evening: kept
        }
    }
    // 'ed', 'edly', 'ing', 'ingly': only when a vowel precedes the suffix.
    let vowel = false;
    for (let i = start - 1; i >= 0; i--) {
        if (isV(w[i])) {
            vowel = true;
            break;
        }
    }
    if (!vowel) return;
    w.length = start;
    const t = longestSuffix(w, w.length, ['at', 'bl', 'iz', 'bb', 'dd', 'ff', 'gg', 'mm', 'nn', 'pp', 'rr', 'tt']);
    if (t === 'at' || t === 'bl' || t === 'iz') {
        w.push('e');
        return;
    }
    if (t !== null) {
        // A double letter: undoubled, unless it follows an initial a, e or o (add, egg, odd kept).
        const before = w.length - 3;
        if (before === 0 && AEO.has(w[0])) return;
        w.length -= 1;
        return;
    }
    if (w.length === p1 && shortv(w, w.length)) w.push('e');
}

function step1c(w: Word): void {
    const last = w.length - 1;
    if (last < 0 || (w[last] !== 'y' && w[last] !== 'Y')) return;
    if (last - 1 <= 0 || isV(w[last - 1])) return;
    w[last] = 'i';
}

const STEP2: ReadonlyArray<[string, string | null]> = [
    ['tional', 'tion'],
    ['enci', 'ence'],
    ['anci', 'ance'],
    ['abli', 'able'],
    ['entli', 'ent'],
    ['izer', 'ize'],
    ['ization', 'ize'],
    ['ational', 'ate'],
    ['ation', 'ate'],
    ['ator', 'ate'],
    ['alism', 'al'],
    ['aliti', 'al'],
    ['alli', 'al'],
    ['fulness', 'ful'],
    ['ousli', 'ous'],
    ['ousness', 'ous'],
    ['iveness', 'ive'],
    ['iviti', 'ive'],
    ['biliti', 'ble'],
    ['bli', 'ble'],
    ['ogist', 'og'],
    ['ogi', null], // 'l' before it → og
    ['fulli', 'ful'],
    ['lessli', 'less'],
    ['li', null], // a valid li-ending before it → deleted
];
const STEP2_MAP = new Map(STEP2);
const STEP2_KEYS = STEP2.map(([k]) => k);

function step2(w: Word, p1: number): void {
    const s = longestSuffix(w, w.length, STEP2_KEYS);
    if (s === null) return;
    const start = w.length - s.length;
    if (start < p1) return;
    if (s === 'ogi') {
        if (w[start - 1] === 'l') replaceEnd(w, 3, 'og');
        return;
    }
    if (s === 'li') {
        if (start > 0 && VALID_LI.has(w[start - 1])) w.length = start;
        return;
    }
    replaceEnd(w, s.length, STEP2_MAP.get(s)!);
}

const STEP3: ReadonlyArray<[string, string]> = [
    ['tional', 'tion'],
    ['ational', 'ate'],
    ['alize', 'al'],
    ['icate', 'ic'],
    ['iciti', 'ic'],
    ['ical', 'ic'],
    ['ful', ''],
    ['ness', ''],
    ['ative', ''], // only in R2
];
const STEP3_MAP = new Map(STEP3);
const STEP3_KEYS = STEP3.map(([k]) => k);

function step3(w: Word, p1: number, p2: number): void {
    const s = longestSuffix(w, w.length, STEP3_KEYS);
    if (s === null) return;
    const start = w.length - s.length;
    if (start < p1) return;
    if (s === 'ative' && start < p2) return;
    replaceEnd(w, s.length, STEP3_MAP.get(s)!);
}

const STEP4_KEYS = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize', 'ion'];

function step4(w: Word, p2: number): void {
    const s = longestSuffix(w, w.length, STEP4_KEYS);
    if (s === null) return;
    const start = w.length - s.length;
    if (start < p2) return;
    if (s === 'ion' && w[start - 1] !== 's' && w[start - 1] !== 't') return;
    w.length = start;
}

function step5(w: Word, p1: number, p2: number): void {
    const last = w.length - 1;
    if (last < 0) return;
    if (w[last] === 'e') {
        if (last >= p2 || (last >= p1 && !shortv(w, last))) w.length = last;
    } else if (w[last] === 'l') {
        if (last >= p2 && w[last - 1] === 'l') w.length = last;
    }
}

/** The Snowball English stem of one lower-cased word (`stem` in english.sbl). */
export function porter2Stem(input: string): string {
    const exception = EXCEPTIONS.get(input);
    if (exception !== undefined) return exception;
    const w: Word = Array.from(input);
    if (w.length < 3) return input;
    const yFound = prelude(w);
    const { p1, p2 } = markRegions(w);
    step1a(w);
    step1b(w, p1);
    step1c(w);
    step2(w, p1);
    step3(w, p1, p2);
    step4(w, p2);
    step5(w, p1, p2);
    let out = w.join('');
    if (yFound) out = out.replaceAll('Y', 'y');
    return out;
}
