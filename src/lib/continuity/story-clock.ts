/**
 * WHEN A FACT HOLDS, in story order (Phase 4.2, D28; D25). Pure.
 *
 * A fact's story time is first its own: the free-text `storyTimeFrom` /
 * `storyTimeTo` the source gave. The STORY CLOCK adds the book's ORDER (D25 as
 * the owner amended it: ONE free order per book and kind, the rank alone — a
 * beat in Act 2 may stand before one in Act 1, so before and after come from
 * the rank and never from the act). A fact has a POSITION when
 *
 *   • it was drawn from an ordered element's own entry (a plot beat's, a
 *     timeline event's: what that entry states holds at that point), or
 *   • its story time names one ordered element exactly (the element's name, by
 *     name key, held by one element of the book; a range to another element is
 *     not a point and gets none).
 *
 * Positions compare only within ONE kind's order (`compareRanks`, in code,
 * never a collation): a beat and a timeline event are in different orders, so
 * neither is before the other. Two facts OVERLAP when both have a position in
 * the same order and it is the same element; when either has none, or their
 * orders differ, 4.1's textual rule decides (the same stated times, or either
 * unstated).
 */
import { compareRanks } from '@/lib/bible/story-order';
import { nameKey } from '@/lib/enrichment/validate';
import { foldWithOrigins } from '@/lib/sources/quote';

/** A fact as the clock reads it. */
export interface ClockFact {
    readonly storyTimeFrom: string | null;
    readonly storyTimeTo: string | null;
    /** The element whose accepted entry stated it (a bible fact's owner), or null. */
    readonly ownerElementId?: string | null;
}

/** A placed element of an ordered kind (its rank set). */
export interface OrderedElement {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly orderRank: string;
}

export interface StoryPosition {
    readonly kind: string;
    readonly rank: string;
    readonly elementId: string;
}

export interface StoryClock {
    positionOf(fact: ClockFact): StoryPosition | null;
}

/** A clock that knows no order: every fact falls back to its stated time. */
export const NO_ORDER: StoryClock = Object.freeze({ positionOf: () => null });

/** The clock over a book's placed elements (`elements` may hold any; only those with a rank count). */
export function storyClock(elements: readonly OrderedElement[]): StoryClock {
    const byId = new Map<string, StoryPosition>();
    const byName = new Map<string, StoryPosition | null>();
    for (const e of elements) {
        if (!e.orderRank) continue;
        const p = { kind: e.kind, rank: e.orderRank, elementId: e.id };
        byId.set(e.id, p);
        const key = nameKey(e.name);
        if (key === '') continue;
        byName.set(key, byName.has(key) ? null : p);
    }
    return Object.freeze({
        positionOf(fact: ClockFact): StoryPosition | null {
            if (fact.ownerElementId) {
                const own = byId.get(fact.ownerElementId);
                if (own) return own;
            }
            const from = fact.storyTimeFrom ? byName.get(nameKey(fact.storyTimeFrom)) ?? null : null;
            if (!from) return null;
            if (fact.storyTimeTo && fact.storyTimeTo.trim() !== '') {
                const to = byName.get(nameKey(fact.storyTimeTo)) ?? null;
                if (!to || to.elementId !== from.elementId) return null;
            }
            return from;
        },
    });
}

function timeKey(t: string | null): string | null {
    return t && t.trim() !== '' ? foldWithOrigins(t).text : null;
}

/** 4.1's textual rule: the same stated times, or either unstated. */
export function textTimesOverlap(a: ClockFact, b: ClockFact): boolean {
    const [af, at, bf, bt] = [timeKey(a.storyTimeFrom), timeKey(a.storyTimeTo), timeKey(b.storyTimeFrom), timeKey(b.storyTimeTo)];
    if ((af === null && at === null) || (bf === null && bt === null)) return true;
    return af === bf && at === bt;
}

/** Do the two facts hold at an overlapping story time? (The header.) */
export function overlaps(a: ClockFact, b: ClockFact, clock: StoryClock = NO_ORDER): boolean {
    const pa = clock.positionOf(a);
    const pb = clock.positionOf(b);
    if (pa && pb && pa.kind === pb.kind) return pa.elementId === pb.elementId;
    return textTimesOverlap(a, b);
}

/** Is `a` strictly before `b` in one order? False when either has no position, or their orders differ. */
export function before(a: ClockFact, b: ClockFact, clock: StoryClock = NO_ORDER): boolean {
    const pa = clock.positionOf(a);
    const pb = clock.positionOf(b);
    if (!pa || !pb || pa.kind !== pb.kind || pa.elementId === pb.elementId) return false;
    return compareRanks(pa.rank, pb.rank) < 0;
}
