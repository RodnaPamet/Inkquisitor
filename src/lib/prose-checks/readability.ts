/**
 * Readability per scene (Phase 5.2, D34): the Flesch reading-ease score and
 * the Flesch–Kincaid grade, from words, sentences and syllables. The formulas
 * are the published ones (public-domain arithmetic); the syllable counter is
 * ORIGINAL and approximate — vowel groups, a silent final e, the "-le" and
 * "-ed" endings — good enough for a band, never a verdict. A scene of fewer
 * than `READABILITY_MIN_WORDS` words is not assessed (rule 6).
 */
import { READABILITY_MIN_WORDS, readabilityBand, type ReadabilityBand } from './vocabulary';

const VOWEL_GROUP = /[aeiouy]+/g;

/** Syllables in one word (letters only; a word of no vowel counts one). */
export function syllables(word: string): number {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (w.length === 0) return 0;
    if (w.length <= 3) return 1;
    let count = (w.match(VOWEL_GROUP) ?? []).length;
    // A silent final e ("make"), but not the syllabic "-le" after a consonant ("table").
    if (w.endsWith('e') && !(w.endsWith('le') && !/[aeiouy]/.test(w.charAt(w.length - 3)))) count--;
    // "-ed" is silent except after t or d ("walked" one, "wanted" two).
    if (w.endsWith('ed') && !/[td]/.test(w.charAt(w.length - 3)) && count > 1) count--;
    // "-es" after most consonants is silent ("makes"), but not after s, x, z, ch, sh ("boxes").
    if (w.endsWith('es') && !/(?:s|x|z|ch|sh)es$/.test(w) && count > 1) count--;
    return Math.max(1, count);
}

export interface Readability {
    words: number;
    sentences: number;
    syllables: number;
    readingEase: number;
    gradeLevel: number;
    band: ReadabilityBand;
}

/** The scene's figures, rounded to one decimal; null below the word floor or with no sentence. */
export function readability(words: readonly string[], sentences: number): Readability | null {
    if (words.length < READABILITY_MIN_WORDS || sentences === 0) return null;
    let syl = 0;
    for (const w of words) syl += syllables(w);
    const wps = words.length / sentences;
    const spw = syl / words.length;
    const ease = Math.round((206.835 - 1.015 * wps - 84.6 * spw) * 10) / 10;
    const grade = Math.round((0.39 * wps + 11.8 * spw - 15.59) * 10) / 10;
    return { words: words.length, sentences, syllables: syl, readingEase: ease, gradeLevel: grade, band: readabilityBand(ease) };
}
