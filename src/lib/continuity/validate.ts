/**
 * THE RULES A DEEP-CHECK PAIR IS HELD TO (Phase 4.2, D28; rule 1). Pure.
 * The model only names numbers and a kind; code decides what is proposed. In
 * order, each refusal a named, counted code (never a row):
 *
 *   INVALID_ITEM   the pair did not parse
 *   OVER_LIMIT     past `CONTINUITY_PAIRS_MAX`
 *   UNKNOWN_FACT   a number names no fact the call was shown
 *   SAME_FACT      a fact paired with itself
 *   DUPLICATE      the same pair twice in one answer (either order)
 *   DRAFT_PAIR     two DRAFT facts paired with each other (D35 addendum A): a draft
 *                  fact is held only against the bible, never against the draft
 *
 * A pair the book already holds a proposal for (decided or not, either order)
 * is not proposed again: the caller asks the database, under the book's fact
 * lock, and counts it ALREADY_PROPOSED.
 */
import { CONTINUITY_PAIRS_MAX } from './prompt';
import { parseContinuityOutput } from './schema';
import type { ContradictionKind } from './vocabulary';

export const CONTINUITY_REFUSALS = ['INVALID_ITEM', 'OVER_LIMIT', 'UNKNOWN_FACT', 'SAME_FACT', 'DUPLICATE', 'DRAFT_PAIR', 'ALREADY_PROPOSED', 'NOT_LIVE'] as const;
export type ContinuityRefusal = (typeof CONTINUITY_REFUSALS)[number];

export interface ShownPair {
    /** The facts' ids, as the call was shown them. */
    readonly a: string;
    readonly b: string;
    readonly kind: ContradictionKind;
}

export function validateContinuityPairs(
    raw: unknown,
    shownIds: readonly string[],
    options: { draftIds?: ReadonlySet<string> } = {},
): { pairs: ShownPair[]; refusals: Partial<Record<ContinuityRefusal, number>>; drafted: number } {
    const draft = options.draftIds ?? new Set<string>();
    const { pairs, malformed } = parseContinuityOutput(raw);
    const refusals: Partial<Record<ContinuityRefusal, number>> = {};
    const refuse = (code: ContinuityRefusal, n = 1) => (refusals[code] = (refusals[code] ?? 0) + n);
    if (malformed > 0) refuse('INVALID_ITEM', malformed);
    const out: ShownPair[] = [];
    const seen = new Set<string>();
    pairs.forEach((p, i) => {
        if (i >= CONTINUITY_PAIRS_MAX) return refuse('OVER_LIMIT');
        const a = shownIds[p.first - 1];
        const b = shownIds[p.second - 1];
        if (a === undefined || b === undefined) return refuse('UNKNOWN_FACT');
        if (a === b) return refuse('SAME_FACT');
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) return refuse('DUPLICATE');
        seen.add(key);
        if (draft.has(a) && draft.has(b)) return refuse('DRAFT_PAIR');
        out.push({ a, b, kind: p.kind });
    });
    return { pairs: out, refusals, drafted: pairs.length + malformed };
}
