/**
 * Character names that look or sound alike (Phase 5.2, D34). Original rules,
 * compared on FIRST names (a name's first word, folded), the part a reader
 * meets most:
 *
 *   SAME_FIRST_NAME  two characters share a first name ("John Reed", "John Ash")
 *   ONE_LETTER       one edit apart, both at least four letters ("Mara", "Maya")
 *   SAME_SHAPE       same first letter, same last letter, same length, at least
 *                    five letters, at most two letters differing ("Kalen", "Karen")
 *   SOUNDS_ALIKE     the same sound key (below), both at least four letters
 *                    ("Catherine", "Kathryn")
 *
 * The sound key is ORIGINAL and rough: the first letter's sound class, then the
 * consonants' classes in order with doubles and vowels dropped (c/k/q, s/z,
 * f/ph/v, d/t, b/p, g/j, m/n). Pairs are bounded: the caller passes at most
 * `PROSE_CHARACTER_NAMES_MAX` names (an O(n²) comparison of at most 125,000
 * pairs of short strings).
 */
import { foldWord } from '@/lib/search/analyse';
import type { SimilarNameReason } from './vocabulary';

export interface NamedCharacter {
    id: string;
    name: string;
}

export interface SimilarPair<T extends NamedCharacter = NamedCharacter> {
    a: T;
    b: T;
    why: SimilarNameReason;
}

/** A name's first word, folded; '' for a name with no letter. */
export function firstNameOf(name: string): string {
    const first = name.trim().split(/\s+/)[0] ?? '';
    return foldWord(first.replace(/[^\p{L}\p{M}'’-]/gu, ''));
}

/** Levenshtein distance, stopping early past `max` (returns max + 1). */
export function editDistance(a: string, b: string, max = 2): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            cur.push(v);
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return max + 1;
        prev = cur;
    }
    return prev[b.length];
}

const CLASSES: ReadonlyArray<[RegExp, string]> = [
    [/ph/g, 'f'],
    [/ck/g, 'k'],
    [/th/g, 't'],
    [/[ckq]/g, 'k'],
    [/[sz]/g, 's'],
    [/[fv]/g, 'f'],
    [/[dt]/g, 't'],
    [/[bp]/g, 'p'],
    [/[gj]/g, 'g'],
    [/[mn]/g, 'n'],
];

/** The rough sound key of a folded name. */
export function soundKey(name: string): string {
    let s = name.replace(/[^a-z]/g, '');
    if (s === '') return '';
    for (const [re, to] of CLASSES) s = s.replace(re, to);
    const head = s.charAt(0);
    const rest = s
        .slice(1)
        .replace(/[aeiouyhw]/g, '')
        .replace(/(.)\1+/g, '$1');
    return head + rest;
}

/** Why two first names are alike, or null. */
export function similarity(a: string, b: string): SimilarNameReason | null {
    if (a === '' || b === '') return null;
    if (a === b) return 'SAME_FIRST_NAME';
    if (a.length >= 4 && b.length >= 4 && editDistance(a, b, 1) <= 1) return 'ONE_LETTER';
    if (a.length >= 5 && a.length === b.length && a[0] === b[0] && a[a.length - 1] === b[b.length - 1]) {
        let diff = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
        if (diff <= 2) return 'SAME_SHAPE';
    }
    if (a.length >= 4 && b.length >= 4) {
        const ka = soundKey(a);
        if (ka.length >= 2 && ka === soundKey(b)) return 'SOUNDS_ALIKE';
    }
    return null;
}

/** Every alike pair among the characters, in a stable order (a before b by position in the list). */
export function similarNamePairs<T extends NamedCharacter>(characters: readonly T[]): Array<SimilarPair<T>> {
    const firsts = characters.map((c) => firstNameOf(c.name));
    const out: Array<SimilarPair<T>> = [];
    for (let i = 0; i < characters.length; i++) {
        for (let j = i + 1; j < characters.length; j++) {
            const why = similarity(firsts[i], firsts[j]);
            if (why) out.push({ a: characters[i], b: characters[j], why });
        }
    }
    return out;
}
