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

/**
 * Idioms in which a negating word negates nothing that follows: "not only
 * brave but kind" says she IS brave, "there is no doubt she loves him" that
 * she does. Read as negations they refused the faithful "She is brave." and
 * "She loves him." The negating word, then the word after it.
 */
const NON_NEGATING_IDIOMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['not', new Set(['only', 'just', 'merely', 'simply'])],
    ['no', new Set(['doubt', 'matter', 'wonder'])],
]);

/** True when a normalised word negates on its own. */
function isNegator(w: string): boolean {
    return NEGATORS.has(w) || /n['’]t$/.test(w);
}

/** True when the word at `i` negates what follows it (a negator, not opening one of the idioms above). */
function negatesAt(ws: readonly string[], i: number): boolean {
    if (!isNegator(ws[i])) return false;
    const next = ws[i + 1];
    return !(next !== undefined && NON_NEGATING_IDIOMS.get(ws[i])?.has(next));
}

/** True when the clause holds a negating word. */
export function negated(clause: string): boolean {
    const ws = words(normaliseText(clause));
    return ws.some((_, i) => negatesAt(ws, i));
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
export function polarisedTokens(clause: string): Map<string, boolean> {
    const out = new Map<string, boolean>();
    let under = false;
    const ws = words(normaliseText(clause));
    for (const [i, w] of ws.entries()) {
        if (isNegator(w)) {
            if (negatesAt(ws, i)) under = true;
            continue;
        }
        for (const t of contentTokens(w)) if (!out.has(t)) out.set(t, under);
    }
    return out;
}

/** The source clauses sharing the most content words with `mine`, and whether one of them agrees on every shared word's polarity. */
function bestMatch(mine: ReadonlyMap<string, boolean>, sourceClauses: ReadonlyArray<ReadonlyMap<string, boolean>>): { shared: number; agrees: boolean } {
    let best = 0;
    let agrees = false;
    for (const src of sourceClauses) {
        const shared = [...mine.keys()].filter((t) => src.has(t));
        if (shared.length === 0 || shared.length < best) continue;
        const same = shared.every((t) => src.get(t) === mine.get(t));
        agrees = shared.length > best ? same : agrees || same;
        best = shared.length;
    }
    return { shared: best, agrees };
}

/**
 * Each clause of `sentence` agrees with a best-matching source clause (the
 * one sharing the most content words) on whether each shared word is under a
 * negation.
 *
 * `prior` is what the sentence REPLACES (an UPDATE's stored value): grounding
 * may draw on it, but the answers are the evidence for the change. A clause
 * that restates mostly an evidence clause (shares at least half its content
 * words with one) keeps THAT clause's polarity, even where the stored value
 * said the opposite: "Mara does not trust her brother Tomas" from the answer
 * "Mara doesn't trust Tomas" over the stored "Mara trusts her brother Tomas"
 * is the correction the answer asked for, and the stored clause, sharing more
 * words, used to refuse it. Any other clause is judged against the best match
 * among evidence and prior together, as before; with no prior nothing changes.
 */
export function polarityKept(sentence: string, sources: readonly string[], prior: readonly string[] = []): boolean {
    const evidence = sources.flatMap(clauses).map(polarisedTokens);
    const everything = prior.length === 0 ? evidence : [...evidence, ...prior.flatMap(clauses).map(polarisedTokens)];
    for (const clause of clauses(sentence)) {
        const mine = polarisedTokens(clause);
        if (mine.size === 0) continue;
        const fromEvidence = bestMatch(mine, evidence);
        if (fromEvidence.shared * 2 >= mine.size) {
            if (!fromEvidence.agrees) return false;
            continue;
        }
        const overall = bestMatch(mine, everything);
        if (overall.shared > 0 && !overall.agrees) return false;
    }
    return true;
}
