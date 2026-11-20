/**
 * DOES A PROPOSED SENTENCE KEEP ITS SOURCE'S POLARITY? (Phase 2.H, issue #39
 * item 1.)
 *
 * Grounding (`groundSentence`, 2.2) is lexical: 70 % of a sentence's content
 * words must occur in its sources, and "not" is a stop word. So "she trusts
 * him" grounded on "she does not trust him", and the reverse, an added "not",
 * grounded too. This is the heuristic the validators run beside it: each
 * CLAUSE of the proposed sentence is matched to the source clauses that share
 * the most of its content words, and must agree with one of them on which of
 * the shared words stand under a negation (a negating word earlier in the
 * clause). A clause that shares no content word with
 * any source is left to grounding, which already refuses it.
 *
 * Clauses, not sentences, are compared because one source sentence can hold
 * both polarities ("She does not trust him, but she trusts his sister"; "a
 * custom, not a law"): a proposal of one half must not be refused for the
 * other. The price is a negation split from its verb by a comma ("she does
 * not, in truth, trust him"), which this does not see.
 *
 * A heuristic in validation, not a judge: a negation spelt another way
 * ("she distrusts him", "far from trusting him") is not seen, and a double
 * negation reads as negated. It catches the plain dropped or added "not",
 * which is the mistake a summariser makes.
 */
import { contentTokens, normaliseText, sentences, words } from '@/lib/interview/text';

/** Words that negate a clause on their own; a contraction ending in n't negates too. */
const NEGATORS: ReadonlySet<string> = new Set(['not', 'no', 'never', 'cannot', 'nor', 'neither', 'nobody', 'none', 'nothing', 'nowhere', 'noone']);

/**
 * Where a sentence is cut into clauses: a comma, colon or semicolon, or a
 * contrasting conjunction. Commas too, because a contrastive negation hangs
 * off its own phrase ("It was the autumn, not the spring: October 1961";
 * "only in the kitchen chapters, not at the wedding"): the phrase it negates
 * is not the one a proposal restates.
 */
const CLAUSE_BREAK = /[;:,]|\s\b(?:but|although|though|whereas|while|yet|however)\b/i;

/** True when a normalised word negates on its own. */
function isNegator(w: string): boolean {
    return NEGATORS.has(w) || /n['’]t$/.test(w);
}

/** True when the clause holds a negating word. */
export function negated(clause: string): boolean {
    return words(normaliseText(clause)).some(isNegator);
}

/** The clauses of a text: its sentences, each cut at its joints. */
export function clauses(text: string): string[] {
    return sentences(text)
        .flatMap((s) => s.split(CLAUSE_BREAK))
        .map((c) => c.trim())
        .filter((c) => c !== '');
}

/**
 * A clause's content tokens, each marked NEGATED when a negating word comes
 * before it in the clause: "Ilse does not keep the lighthouse" negates
 * keep and lighthouse, not Ilse; "people could not see their hands" negates
 * neither "dust" nor "darkness" earlier in the same clause.
 */
function polarisedTokens(clause: string): Map<string, boolean> {
    const out = new Map<string, boolean>();
    let under = false;
    for (const w of words(normaliseText(clause))) {
        if (isNegator(w)) {
            under = true;
            continue;
        }
        for (const t of contentTokens(w)) if (!out.has(t)) out.set(t, under);
    }
    return out;
}

/**
 * Each clause of `sentence` agrees with a best-matching source clause (the
 * one sharing the most content words) on whether each shared word is under a
 * negation.
 */
export function polarityKept(sentence: string, sources: readonly string[]): boolean {
    const sourceClauses = sources.flatMap(clauses).map(polarisedTokens);
    for (const clause of clauses(sentence)) {
        const mine = polarisedTokens(clause);
        if (mine.size === 0) continue;
        let best = 0;
        let agrees = false;
        for (const src of sourceClauses) {
            const shared = [...mine.keys()].filter((t) => src.has(t));
            if (shared.length === 0 || shared.length < best) continue;
            const same = shared.every((t) => src.get(t) === mine.get(t));
            agrees = shared.length > best ? same : agrees || same;
            best = shared.length;
        }
        if (best > 0 && !agrees) return false;
    }
    return true;
}
