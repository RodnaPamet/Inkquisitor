/**
 * THE CALLS ONE VERSION IS SENT IN (Phase 4.1; owner decisions of 2026-11-21, the D27 addendum). Pure: the
 * caller hands it the worst-case function (`bibleFactsCallWorstCase`, `cost.ts`).
 *
 * Each call's INPUT is bounded and each call's WORST CASE must fit the per-call cost budget (rule 9, now
 * enforced rather than logged):
 *
 *   1. The changed sections go in batches of at most `maxChars` characters (`pieceSections`; a longer section is
 *      cut at block, sentence or space boundaries). Each call carries the entry's header and its batch, the
 *      existing facts shown and the book's names.
 *   2. A call whose worst case is past the budget is HALVED (its batch re-cut at half its size), down to
 *      `minChars`: smaller pieces before less context.
 *   3. A batch at the floor that still does not fit drops the book's names, then shows fewer existing facts
 *      (halving to none). The facts shown to a call are always a PREFIX of the version's shown list, so a
 *      `contradicts` number means the same fact in every call.
 *   4. Nothing fits: the plan is refused, and nothing is sent (`CALL_OVER_BUDGET`).
 *
 * Facts drawn from several calls are deduplicated by the caller through the claim key, as within one call.
 */
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import { batchChars, pieceSections, sentText, type EntrySection, type RenderedEntry } from './entry-text';
import { bibleFactBlocks, type ShownFact } from './prompt';

export interface PlannedCall {
    /** What this call is shown of the entry (its header and its batch): the text its quotes are checked against. */
    readonly sent: string;
    /** How many of the version's shown facts this call is shown (a prefix). */
    readonly shown: number;
    /** The call's data blocks. */
    readonly blocks: AuthorDataBlock[];
    /** Its worst case, µUSD (at most the budget). */
    readonly worstMicroUsd: number;
}

export type CallPlan = { ok: true; calls: PlannedCall[] } | { ok: false; reason: 'CALL_OVER_BUDGET'; worstMicroUsd: number };

export function planBibleFactCalls(input: {
    entry: RenderedEntry;
    changed: readonly EntrySection[];
    subjects: readonly string[];
    shown: readonly ShownFact[];
    bookNames: readonly string[];
    budgetMicroUsd: number;
    maxChars: number;
    minChars: number;
    worst: (blocks: readonly AuthorDataBlock[]) => number;
}): CallPlan {
    const calls: PlannedCall[] = [];
    const queue = pieceSections(input.changed, input.maxChars);
    const shape = (batch: readonly EntrySection[], shown: number, names: boolean): PlannedCall => {
        const sent = sentText(input.entry, batch);
        const blocks = bibleFactBlocks({ text: sent, subjects: input.subjects, existing: input.shown.slice(0, shown), bookNames: names ? input.bookNames : [] });
        return { sent, shown, blocks, worstMicroUsd: input.worst(blocks) };
    };
    let smallest = Number.POSITIVE_INFINITY;
    while (queue.length > 0) {
        const batch = queue.shift()!;
        const full = shape(batch, input.shown.length, true);
        if (full.worstMicroUsd <= input.budgetMicroUsd) {
            calls.push(full);
            continue;
        }
        const chars = batchChars(batch);
        if (chars > input.minChars) {
            const halves = pieceSections(batch, Math.max(input.minChars, Math.ceil(chars / 2)));
            if (halves.length > 1) {
                queue.unshift(...halves);
                continue;
            }
        }
        let fitted: PlannedCall | null = null;
        for (let k = input.shown.length; ; k = Math.floor(k / 2)) {
            const degraded = shape(batch, k, false);
            smallest = Math.min(smallest, degraded.worstMicroUsd);
            if (degraded.worstMicroUsd <= input.budgetMicroUsd) {
                fitted = degraded;
                break;
            }
            if (k === 0) break;
        }
        if (!fitted) return { ok: false, reason: 'CALL_OVER_BUDGET', worstMicroUsd: smallest };
        calls.push(fitted);
    }
    return { ok: true, calls };
}
