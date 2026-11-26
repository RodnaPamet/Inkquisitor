/**
 * THE VALUE SCORE (Phase 4.4, D30 item 4): how much new information a
 * candidate question would add against what the bible and the facts already
 * hold. Code scores first — deterministic, from the candidate's generator and
 * what the book holds — and a round asks the highest-value candidates first,
 * across generators. A cheap model call may reorder only near-equal candidates
 * (`ORDER_TIE_BAND`, `question-order.ts`); it never changes a score.
 *
 * The score is 0..100. The terms (each a constant here, so a test can hold the
 * ordering they imply):
 *
 *   FRONTIER    an empty field: core 70, optional 45; +4 per field of its element that waits on it (at most +16),
 *               −5 per dependency level past the first (a deeper field adds less until its basis is settled)
 *   SOURCES     a pending fact of the book's sources: 90 when its field is still empty — above any frontier
 *               question on that field (the author's own draft already says it: confirming it is the question,
 *               not asking them to write it again) — and 35 when the bible already fills the field (deciding it
 *               still settles canon)
 *   CONTINUITY  a contradiction 85 (two things the book says cannot both hold), a timeline gap 65, an open
 *               thread (an unpaid promise, an unfound clue, an open question) 55
 *   LADDER      layer by layer, each adding less: 60, 51, 42, 33, 24, 15 for WHAT … EDGE_CASES; +8 on a core field;
 *               −10 for each live fact already held about that very field (at most −30): the facts already say more
 *   RELATIONS   a pair with no relation yet: WANTS / COLLIDE 50, HIDDEN 40; an existing relation's empty field is
 *               scored as a frontier field
 *
 * MINOR: a candidate below `MINOR_VALUE_FLOOR` (30) is minor. A round asks only candidates at or above the floor;
 * when every candidate left is minor the session says so and asks whether to go on (VALUE_FELL), instead of padding
 * a round with them. Once the author says go on, the floor is 0 for that session.
 */
import { LADDER_LAYERS, type LadderLayer, type PairAngle } from '../vocabulary';

export const VALUE_MAX = 100;
export const MINOR_VALUE_FLOOR = 30;
/** Candidates within this many points of each other are near-equal: only they may be reordered by the model. */
export const ORDER_TIE_BAND = 5;

export const FRONTIER_VALUE = Object.freeze({ core: 70, optional: 45, perDependant: 4, dependantsMax: 16, perLevel: 5 });
export const SOURCE_VALUE = Object.freeze({ emptyField: 90, filledField: 35 });
export const CONTINUITY_VALUE = Object.freeze({ CONTRADICTION: 85, TIMELINE_GAP: 65, THREAD: 55 });
export const LADDER_VALUE = Object.freeze({ first: 60, step: 9, core: 8, perFact: 10, factsMax: 30 });
export const PAIR_VALUE: Readonly<Record<PairAngle, number>> = Object.freeze({ WANTS: 50, COLLIDE: 50, HIDDEN: 40 });

export function clampValue(v: number): number {
    return Math.max(0, Math.min(VALUE_MAX, Math.round(v)));
}

export function frontierValue(f: { required: boolean; level: number; dependants: number }): number {
    const base = f.required ? FRONTIER_VALUE.core : FRONTIER_VALUE.optional;
    return clampValue(base + Math.min(FRONTIER_VALUE.dependantsMax, f.dependants * FRONTIER_VALUE.perDependant) - Math.max(0, f.level - 1) * FRONTIER_VALUE.perLevel);
}

export function sourceValue(fieldFilled: boolean): number {
    return fieldFilled ? SOURCE_VALUE.filledField : SOURCE_VALUE.emptyField;
}

export function ladderValue(layer: LadderLayer, f: { required: boolean; factsHeld: number }): number {
    const index = LADDER_LAYERS.indexOf(layer);
    return clampValue(LADDER_VALUE.first - index * LADDER_VALUE.step + (f.required ? LADDER_VALUE.core : 0) - Math.min(LADDER_VALUE.factsMax, f.factsHeld * LADDER_VALUE.perFact));
}

export function isMinor(value: number, floor: number = MINOR_VALUE_FLOOR): boolean {
    return value < floor;
}
