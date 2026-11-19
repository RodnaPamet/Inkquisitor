/**
 * Text comparison for the question engine (Phase 2.2): one normalisation,
 * one tokeniser, one light stemmer, and the GROUNDING TEST (design 4.5) that
 * a recommended answer — and in 2.5 every sentence of a proposed bible value —
 * must pass against the author's own words. Pure, no model.
 *
 *   normaliseText   Unicode NFKC, lower case, zero-width and other format
 *                   characters removed, look-alike letters folded to ASCII
 *                   where a mapping exists, whitespace collapsed.
 *   contentTokens   words of the normalised text, stop words dropped, each
 *                   reduced by a light suffix stripper.
 *   grounded        a sentence is supported when at least GROUNDING_THRESHOLD
 *                   of its content tokens occur in the sources and every
 *                   capitalised word of the original (a likely name) does.
 *
 * The look-alike table covers the Cyrillic and Greek letters that pass for
 * Latin ones (the staged adversarial evaluation set uses them); NFKC already
 * folds the full-width and mathematical alphabets.
 */

/** A sentence is supported when at least this share of its content tokens occur in its sources (design 4.5). */
export const GROUNDING_THRESHOLD = 0.7;

const FORMAT_CHARS = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

const LOOK_ALIKES: Readonly<Record<string, string>> = {
    // Cyrillic
    а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', и: 'u', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
    ѕ: 's', і: 'i', ї: 'i', ј: 'j', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', һ: 'h', ү: 'y', ғ: 'f',
    // Greek
    α: 'a', β: 'b', γ: 'y', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
};
const LOOK_ALIKE_RE = new RegExp(`[${Object.keys(LOOK_ALIKES).join('')}]`, 'gu');

export function normaliseText(input: string): string {
    return input
        .normalize('NFKC')
        .toLowerCase()
        .replace(FORMAT_CHARS, '')
        .replace(LOOK_ALIKE_RE, (c) => LOOK_ALIKES[c] ?? c)
        .replace(/\s+/g, ' ')
        .trim();
}

/** A short, fixed list: function words and the words every question shares. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
    (
        'a an and are as at be been being but by can could did do does for from had has have he her hers him his how i if in into ' +
        'is it its me my no nor not of on or our ours she should so than that the their theirs them then there these they this those ' +
        'to too up us was we were what when where which while who whom why will with would you your yours yourself'
    ).split(' '),
);

/** A light suffix stripper: plurals, -ed, -ing, -ly (design 4.5). Deterministic and conservative. */
export function stem(word: string): string {
    let w = word;
    if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
    else if (w.length > 4 && w.endsWith('es') && /(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2);
    return w;
}

/** The words of a normalised text (letters and digits; an apostrophe inside a word is kept). */
export function words(normalised: string): string[] {
    return normalised.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

/** The content tokens of a text: normalised, stop words dropped, stemmed. */
export function contentTokens(text: string, extraStopWords: ReadonlySet<string> = new Set()): string[] {
    return words(normaliseText(text))
        .filter((w) => !STOP_WORDS.has(w) && !extraStopWords.has(w))
        .map(stem);
}

/** The sentences of a text: split after `.`, `!` or `?` followed by a space, and at line breaks. */
export function sentences(text: string): string[] {
    return text
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/** Words written with a capital in the ORIGINAL text, not at the start of a sentence: likely names. */
export function capitalisedWords(sentence: string): string[] {
    const tokens = sentence.normalize('NFKC').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
    return tokens.slice(1).filter((t) => /^\p{Lu}/u.test(t) && t !== 'I');
}

export interface GroundingVerdict {
    supported: boolean;
    /** The share of the sentence's content tokens found in the sources (1 for a sentence with none). */
    coverage: number;
    /** Capitalised words of the sentence that no source contains. */
    unsupportedNames: string[];
}

/** Is `sentence` supported by `sources` (design 4.5)? */
export function groundSentence(sentence: string, sources: readonly string[]): GroundingVerdict {
    const sourceText = sources.join('\n');
    const sourceTokens = new Set(contentTokens(sourceText));
    const sourceWords = new Set(words(normaliseText(sourceText)));
    const tokens = contentTokens(sentence);
    const found = tokens.filter((t) => sourceTokens.has(t)).length;
    const coverage = tokens.length === 0 ? 1 : found / tokens.length;
    const unsupportedNames = capitalisedWords(sentence).filter((w) => !sourceWords.has(normaliseText(w)));
    return { supported: coverage >= GROUNDING_THRESHOLD && unsupportedNames.length === 0, coverage, unsupportedNames };
}

/** Every sentence of `text` is supported by `sources`; one unsupported sentence fails the whole text. */
export function grounded(text: string, sources: readonly string[]): boolean {
    const parts = sentences(text);
    return parts.length > 0 && parts.every((s) => groundSentence(s, sources).supported);
}
