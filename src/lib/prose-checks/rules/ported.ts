/**
 * The PORTED rules (Phase 5.2, D34): checks run by MIT-licensed packages,
 * credited in NOTICE, each narrowed for fiction. Server-only — the packages
 * load only in the worker (and the unit tests), never in a browser bundle.
 *
 *   write-good (btford)       intensifiers (its "weasel" check, kept only for
 *                             the intensifiers in `INTENSIFIERS`, each offered a
 *                             deletion), wordy phrases ("too wordy", MULTI-word
 *                             phrases only: its single words — "however",
 *                             "purchase", "depart" — are ordinary fiction),
 *                             clichés
 *   retext (wooorm)           repeated words ("the the"), offered the deletion
 *                             of the repeat, through retext-english's parser
 *   alex's rules (wooorm)     the inclusive-language check: retext-equality and
 *                             retext-profanities, the two retext plugins the
 *                             alex package is built from. The alex package
 *                             itself is a command-line wrapper whose own
 *                             dependencies fail the audit gate (moderate, its
 *                             CLI's glob and minimatch); its rules are these
 *                             two plugins, run with alex's profanity filter at
 *                             "likely" only. OFF by default, NARRATION only
 *                             (D34 item 2), and it never flags a personal
 *                             pronoun: in fiction "he" and "she" are characters.
 *
 * None of them ever offers wording of its own: an alternative a package lists
 * is not shown (D34 item 4 allows only deletions, the author's own swaps and
 * spelling variants).
 */
import { retext } from 'retext';
import retextEnglish from 'retext-english';
import retextEquality from 'retext-equality';
import retextProfanities from 'retext-profanities';
import retextRepeatedWords from 'retext-repeated-words';
import writeGood from 'write-good';
import type { Word } from '../segments';
import type { DraftSuggestion, FindingDraft, RuleContext } from './types';

const set = (words: string): ReadonlySet<string> => new Set(words.split(' ').filter(Boolean));

/** The intensifiers kept from write-good's weasel words: words that only turn a following word up. */
export const INTENSIFIERS = set('very extremely quite fairly completely exceedingly remarkably');

/** Multi-word phrases of write-good's wordy list that are ordinary narration ("It was dark."). */
const WORDY_ALLOWED: ReadonlySet<string> = new Set(['it is', 'it was', 'all of', 'in between', 'in addition', 'outside of', 'not many', 'not often', 'not unless', 'the month of']);

function wordyAllowed(phrase: string): boolean {
    return WORDY_ALLOWED.has(phrase.toLowerCase().split(/\s+/).join(' '));
}

/** The first word starting at or after `pos`, by binary search over the words. */
function wordAt(words: readonly Word[], pos: number): Word | null {
    let lo = 0;
    let hi = words.length - 1;
    let found: Word | null = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (words[mid].start >= pos) {
            found = words[mid];
            hi = mid - 1;
        } else lo = mid + 1;
    }
    return found;
}

/** The deletion of an intensifier and the space after it, re-capitalising the next word when the intensifier opened a sentence. */
function intensifierDeletion(ctx: RuleContext, w: Word): DraftSuggestion | undefined {
    const next = ctx.seg.words[w.index + 1];
    const between = next ? ctx.text.slice(w.end, next.start) : '';
    if (!next || next.sentence !== w.sentence || between.length === 0 || between.trim() !== '' || !/^\p{L}/u.test(next.raw)) return undefined;
    const opensSentence = ctx.seg.sentences[w.sentence]?.firstWord === w.index;
    if (opensSentence && /^\p{Lu}/u.test(w.raw)) {
        return { start: w.start, end: next.start + 1, replacement: next.raw.charAt(0).toUpperCase() };
    }
    return { start: w.start, end: next.start, replacement: '' };
}

export function writeGoodRules(ctx: RuleContext): FindingDraft[] {
    const t = ctx.text;
    const out: FindingDraft[] = [];
    for (const m of writeGood(t, { passive: false, illusion: false, so: false, thereIs: false, weasel: true, adverb: false, tooWordy: false, cliches: false, eprime: false })) {
        ctx.work.ops++;
        const w = wordAt(ctx.seg.words, m.index);
        if (!w || w.start !== m.index || !INTENSIFIERS.has(w.surface)) continue;
        const suggestion = intensifierDeletion(ctx, w);
        out.push({ ruleId: 'intensifiers', start: w.start, end: w.end, params: { word: w.raw }, ...(suggestion ? { suggestion } : {}) });
    }
    for (const m of writeGood(t, { passive: false, illusion: false, so: false, thereIs: false, weasel: false, adverb: false, tooWordy: true, cliches: false, eprime: false })) {
        ctx.work.ops++;
        const phrase = t.slice(m.index, m.index + m.offset);
        if (!/\s/.test(phrase) || wordyAllowed(phrase)) continue;
        out.push({ ruleId: 'wordy', start: m.index, end: m.index + m.offset, params: { phrase } });
    }
    for (const m of writeGood(t, { passive: false, illusion: false, so: false, thereIs: false, weasel: false, adverb: false, tooWordy: false, cliches: true, eprime: false })) {
        ctx.work.ops++;
        out.push({ ruleId: 'cliches', start: m.index, end: m.index + m.offset, params: { phrase: t.slice(m.index, m.index + m.offset) } });
    }
    return out;
}

/** Personal pronouns retext-equality would flag ("he", "she"…): characters, in fiction. */
const PRONOUNS = set('he she him her his hers himself herself he’s she’s he\'s she\'s');

/** One processor per configuration, built when first needed (no timer, no state between texts). */
let plainProcessor: ReturnType<typeof buildProcessor> | null = null;
let alexProcessor: ReturnType<typeof buildProcessor> | null = null;

function buildProcessor(alex: boolean) {
    const p = retext().use(retextEnglish).use(retextRepeatedWords);
    return alex ? p.use(retextEquality).use(retextProfanities, { sureness: 2 }) : p;
}

function processorFor(alex: boolean) {
    if (alex) return (alexProcessor ??= buildProcessor(true));
    return (plainProcessor ??= buildProcessor(false));
}

export function retextRules(ctx: RuleContext, alex: boolean): FindingDraft[] {
    const file = processorFor(alex).processSync(ctx.text);
    const out: FindingDraft[] = [];
    for (const m of file.messages) {
        ctx.work.ops++;
        const start = m.place && 'start' in m.place ? m.place.start.offset : undefined;
        const end = m.place && 'end' in m.place ? m.place.end.offset : undefined;
        if (start === undefined || end === undefined || end <= start) continue;
        const actual = ctx.text.slice(start, end);
        if (m.source === 'retext-repeated-words') {
            // "The the": delete from the end of the first word to the end of the second.
            const first = wordAt(ctx.seg.words, start);
            if (!first || first.start !== start) continue;
            const second = ctx.seg.words[first.index + 1];
            if (!second || second.end !== end) continue;
            out.push({ ruleId: 'repeated-words', start: second.start, end: second.end, params: { word: second.raw }, suggestion: { start: first.end, end: second.end, replacement: '' } });
        } else if (alex && (m.source === 'retext-equality' || m.source === 'retext-profanities')) {
            if (PRONOUNS.has(actual.toLowerCase())) continue;
            out.push({ ruleId: 'inclusive-language', start, end, params: { word: actual, kind: m.source === 'retext-profanities' ? 'profanity' : 'equality' } });
        }
    }
    return out;
}
