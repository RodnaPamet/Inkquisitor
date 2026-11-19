/**
 * How complete a set of bible entries is: fields filled out of the fields
 * their kind's template has (Phase 1.2, the book board).
 *
 * Rule 6 of the roadmap: ZERO IS NEVER COMPLETE. A figure over nothing is not
 * a figure, so the two empty denominators each read as a state, never as a
 * percentage:
 *
 *   - a template with no fields     → `not-assessed` (there is nothing to fill,
 *                                     so neither 0% nor 100% would be true);
 *   - no entries of the kind        → `not-started`;
 *   - otherwise                     → `measured`, with `filled` of `total`.
 *
 * The emptiness of the denominator is tested in the same expression that
 * computes the ratio, so no caller can reach a ratio over nothing. A kind
 * with entries but no field filled is a real 0 of `total`: the entries exist
 * and each has fields waiting, so it is measured, not "not started".
 *
 * Client-safe: no imports.
 */

export type Completeness =
    | { state: 'not-assessed' }
    | { state: 'not-started' }
    | {
          state: 'measured';
          /** Fields filled across the entries (clamped to `total`). */
          filled: number;
          /** Template fields × entries; always > 0. */
          total: number;
          /** `filled / total`, in [0, 1]. */
          ratio: number;
      };

export interface CompletenessInput {
    /** Entries of the kind. */
    entries: number;
    /** Fields filled, summed over the entries. */
    filled: number;
    /** Fields the kind's template has. */
    fieldsPerEntry: number;
}

export function completeness({ entries, filled, fieldsPerEntry }: CompletenessInput): Completeness {
    if (!(fieldsPerEntry > 0)) return { state: 'not-assessed' };
    if (!(entries > 0)) return { state: 'not-started' };
    const total = entries * fieldsPerEntry;
    const clamped = Math.min(Math.max(Math.trunc(filled) || 0, 0), total);
    return { state: 'measured', filled: clamped, total, ratio: clamped / total };
}

/** A measured completeness as a whole percentage; never 100 unless every field is filled. */
export function completenessPercent(c: Extract<Completeness, { state: 'measured' }>): number {
    if (c.filled >= c.total) return 100;
    return Math.min(99, Math.floor(c.ratio * 100));
}
