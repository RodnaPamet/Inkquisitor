/**
 * THE RULES A GAP PICK IS HELD TO (Phase 4.3, D29). Pure. In order, each
 * refusal a named, counted code (never a row):
 *
 *   INVALID_ITEM       the pick did not parse
 *   OVER_LIMIT         past `GAP_PICKS_MAX`
 *   UNKNOWN_CANDIDATE  it picks a number the candidate list does not hold: the model ranks WITHIN the list
 *   DUPLICATE          the same candidate twice
 *   NO_CITATION        its reason cites no candidate
 *   UNKNOWN_CITATION   it cites a number the list does not hold
 *   REASON_EMPTY       no reason left after sanitising
 *   COPIES_INJECTED    markup, a script scheme, an address, the guard's injection hit, or this prompt's own words
 *   NOT_GROUNDED       the reason names none of its cited candidates (by field label or kind label): a reason
 *                      must rest on the candidates it cites
 *
 * D14: a reason that addresses the product is KEPT and flagged POSSIBLE_INSTRUCTION.
 */
import { plainLine } from '@/lib/bible/text';
import { addressesTheProduct } from '@/lib/enrichment/validate';
import { normaliseText } from '@/lib/interview/text';
import { copiesInjected } from '@/lib/sources/validate';
import { disclosesInstructions, promptRuns } from '@/lib/text/prompt-disclosure';
import { GAP_RANK_PROMPT } from './prompt';
import { parseGapRankOutput } from './schema';
import { GAP_CITES_MAX, GAP_PICKS_MAX, GAP_REASON_MAX, type GapCandidate, type GapPick, type GapPickRefusal } from './vocabulary';

const RUNS = promptRuns([GAP_RANK_PROMPT]);

/** The reason names this candidate: its field label (or key's words) or its kind label, folded. */
export function namesCandidate(reason: string, c: Pick<GapCandidate, 'fieldLabel' | 'fieldKey' | 'kindLabel'>): boolean {
    const folded = ` ${normaliseText(reason).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    const has = (phrase: string) => {
        const p = normaliseText(phrase).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        return p !== '' && folded.includes(` ${p} `);
    };
    return has(c.fieldLabel) || has(c.fieldKey.replace(/_/g, ' ')) || has(c.kindLabel) || has(`${c.kindLabel}s`);
}

export function validateGapPicks(raw: unknown, input: { candidates: readonly GapCandidate[]; text: string }): { picks: GapPick[]; refusals: Partial<Record<GapPickRefusal, number>>; drafted: number } {
    const { items, malformed } = parseGapRankOutput(raw);
    const refusals: Partial<Record<GapPickRefusal, number>> = {};
    const refuse = (code: GapPickRefusal, n = 1) => (refusals[code] = (refusals[code] ?? 0) + n);
    if (malformed > 0) refuse('INVALID_ITEM', malformed);
    const byN = new Map(input.candidates.map((c) => [c.n, c] as const));
    const picks: GapPick[] = [];
    const seen = new Set<number>();
    items.forEach((item, i) => {
        if (i >= GAP_PICKS_MAX) return refuse('OVER_LIMIT');
        if (!byN.has(item.candidate)) return refuse('UNKNOWN_CANDIDATE');
        if (seen.has(item.candidate)) return refuse('DUPLICATE');
        const cites = [...new Set(item.cites)];
        if (cites.length === 0) return refuse('NO_CITATION');
        if (cites.some((n) => !byN.has(n))) return refuse('UNKNOWN_CITATION');
        const line = plainLine(item.reason);
        const reason = line.length > GAP_REASON_MAX ? line.slice(0, GAP_REASON_MAX).trimEnd() : line;
        if (reason === '') return refuse('REASON_EMPTY');
        if (copiesInjected([item.reason], input.text) || disclosesInstructions([item.reason], RUNS)) return refuse('COPIES_INJECTED');
        if (!cites.some((n) => namesCandidate(reason, byN.get(n)!))) return refuse('NOT_GROUNDED');
        seen.add(item.candidate);
        picks.push({ n: item.candidate, reason, cites: cites.slice(0, GAP_CITES_MAX), flags: addressesTheProduct(reason) ? ['POSSIBLE_INSTRUCTION'] : [] });
    });
    return { picks, refusals, drafted: items.length + malformed };
}

/** The code's own order as picks: no reason, the candidate citing itself (what an unranked hunt shows). */
export function unrankedPicks(candidates: readonly GapCandidate[]): GapPick[] {
    return candidates.slice(0, GAP_PICKS_MAX).map((c) => ({ n: c.n, reason: null, cites: [c.n], flags: [] }));
}
