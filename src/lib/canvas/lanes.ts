/**
 * The derived maps' layout (Phase 3.2, decision D22): where the plot board and
 * the timeline put each card, worked out from the BIBLE, and where a dropped
 * card asks to go.
 *
 * THE BIBLE IS THE SOURCE OF TRUTH; the map only derives position from it.
 *
 *   plot board   one lane (a column) per act, in the template's option order,
 *                and a last lane for beats with no act yet; a beat's lane is
 *                its `act` FIELD, and its place in the lane its story-order
 *                RANK (`BibleElement.orderRank`). Placed beats first, by rank;
 *                beats not placed yet after them, by name.
 *   timeline     one row of event cards along the story-order axis, placed
 *                events by rank and the events not placed yet after a gap;
 *                below it, one lane per CHARACTER taking part in an event on
 *                the map (a `takes_part_in` relation), with a mark under each
 *                event that character is in. A card sits on the axis, not in
 *                a character's lane: an event with three people in it is one
 *                card and three marks, because a node draws an element once.
 *
 * A MapNode's `x`, `y`, `w`, `h` and `lane` on these maps are this function's
 * output, never the author's: `saveStoryMap` stores what it derives, the
 * canvas seeds from it and moves cards back to it after every change, and a
 * dragged card's drop is turned into an ORDER MOVE (`dropTarget`), which the
 * bible stores; the card then sits where the new order puts it.
 *
 * Pure and client-safe: the server and the canvas call the same function, so
 * what the canvas shows is what a save stores.
 */
import { compareRanks } from '@/lib/bible/story-order';
import type { StoryMapKindValue } from './map-kinds';

export const LANE_CARD_W = 200;
export const LANE_CARD_H = 88;
/** Space between cards in a lane, and around a lane's cards. */
export const LANE_GAP = 16;
/** A lane's heading above its cards. */
export const LANE_HEADER_H = 48;
/** The timeline's left margin, where the character lanes are named. */
export const TIMELINE_LABEL_W = 180;
/** One character lane's height on the timeline. */
export const TIMELINE_LANE_H = 40;

/** A plot beat's lane when it has no act yet. */
export const NO_ACT_LANE = 'no-act';
/** The timeline's two node lanes. */
export const PLACED_LANE = 'placed';
export const UNPLACED_LANE = 'unplaced';

export interface LaneNodeInput {
    elementId: string;
    name: string;
    orderRank: string | null;
    /** A beat's act (an option value of the template's `act` field), or null. */
    act: string | null;
}

export interface ActOption {
    value: string;
    label: string;
}

export interface Participant {
    id: string;
    name: string;
}

/**
 * The map view's participant links grouped by event, each character once per
 * event, in the order given. Linear in the links: a list copied or searched
 * per link would be quadratic in one crowded event.
 */
export function participantsByEvent(links: ReadonlyArray<{ eventId: string; characterId: string; characterName: string }>): Map<string, Participant[]> {
    const byEvent = new Map<string, Participant[]>();
    const seen = new Set<string>();
    for (const l of links) {
        const key = `${l.eventId}\u0000${l.characterId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const list = byEvent.get(l.eventId);
        if (list) list.push({ id: l.characterId, name: l.characterName });
        else byEvent.set(l.eventId, [{ id: l.characterId, name: l.characterName }]);
    }
    return byEvent;
}

export interface LaneWords {
    noAct: string;
    unplaced: string;
    axis: string;
}

const DEFAULT_WORDS: LaneWords = { noAct: NO_ACT_LANE, unplaced: UNPLACED_LANE, axis: PLACED_LANE };

export interface LaneLayoutOptions {
    /** The plot board's acts, in order (the template's `act` options). */
    acts?: readonly ActOption[];
    /** The timeline's participants: characters taking part, by event id. */
    participants?: ReadonlyMap<string, readonly Participant[]>;
    words?: LaneWords;
}

export interface NodePlacement {
    x: number;
    y: number;
    w: number;
    h: number;
    lane: string;
}

/** A labelled band drawn behind the cards: a plot board column, the timeline's axis row or a character row. */
export interface LaneBand {
    key: string;
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    /** `act` and `axis` bands hold cards; `character` bands hold marks. */
    role: 'act' | 'axis' | 'unplaced' | 'character';
}

/** One mark on a character's timeline lane: that character takes part in the event above it. */
export interface LaneMark {
    characterId: string;
    elementId: string;
    x: number;
    y: number;
}

export interface LaneLayout {
    map: Exclude<StoryMapKindValue, 'RELATIONSHIP'>;
    positions: ReadonlyMap<string, NodePlacement>;
    /** Each card lane's cards, in the order shown (placed by rank, then unplaced by name). */
    sequences: ReadonlyMap<string, readonly LaneNodeInput[]>;
    bands: readonly LaneBand[];
    marks: readonly LaneMark[];
}

const byName = (a: LaneNodeInput, b: LaneNodeInput) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || compareRanks(a.elementId, b.elementId);

/** Placed first by rank, then the unplaced by name (then id: a total order, the same everywhere). */
export function sequenceOf(nodes: readonly LaneNodeInput[]): LaneNodeInput[] {
    const placed = nodes.filter((n) => n.orderRank !== null).sort((a, b) => compareRanks(a.orderRank!, b.orderRank!));
    const unplaced = nodes.filter((n) => n.orderRank === null).sort(byName);
    return [...placed, ...unplaced];
}

function plotLayout(nodes: readonly LaneNodeInput[], options: LaneLayoutOptions): LaneLayout {
    const words = options.words ?? DEFAULT_WORDS;
    const acts = options.acts ?? [];
    const known = new Set(acts.map((a) => a.value));
    const laneOf = (n: LaneNodeInput) => (n.act !== null && known.has(n.act) ? n.act : NO_ACT_LANE);
    const lanes: Array<{ key: string; label: string }> = acts.map((a) => ({ key: a.value, label: a.label }));
    if (nodes.some((n) => laneOf(n) === NO_ACT_LANE)) lanes.push({ key: NO_ACT_LANE, label: words.noAct });

    const laneW = LANE_CARD_W + 2 * LANE_GAP;
    const positions = new Map<string, NodePlacement>();
    const sequences = new Map<string, LaneNodeInput[]>();
    let tallest = 0;
    lanes.forEach((lane, i) => {
        const seq = sequenceOf(nodes.filter((n) => laneOf(n) === lane.key));
        sequences.set(lane.key, seq);
        tallest = Math.max(tallest, seq.length);
        seq.forEach((n, j) => {
            positions.set(n.elementId, {
                x: i * laneW + LANE_GAP,
                y: LANE_HEADER_H + LANE_GAP + j * (LANE_CARD_H + LANE_GAP),
                w: LANE_CARD_W,
                h: LANE_CARD_H,
                lane: lane.key,
            });
        });
    });
    const bandH = LANE_HEADER_H + LANE_GAP + Math.max(1, tallest) * (LANE_CARD_H + LANE_GAP);
    const bands: LaneBand[] = lanes.map((lane, i) => ({ key: lane.key, label: lane.label, x: i * laneW, y: 0, w: laneW, h: bandH, role: 'act' }));
    return { map: 'PLOT', positions, sequences, bands, marks: [] };
}

function timelineLayout(nodes: readonly LaneNodeInput[], options: LaneLayoutOptions): LaneLayout {
    const words = options.words ?? DEFAULT_WORDS;
    const slotW = LANE_CARD_W + LANE_GAP;
    const seq = sequenceOf(nodes);
    const placed = seq.filter((n) => n.orderRank !== null);
    const unplaced = seq.filter((n) => n.orderRank === null);
    const cardY = LANE_HEADER_H + LANE_GAP;
    const slotX = (i: number) => TIMELINE_LABEL_W + i * slotW;
    // The unplaced zone starts one slot after the axis: with nothing placed
    // yet, that empty slot is where the first event is dropped.
    const unplacedStart = placed.length + (unplaced.length > 0 ? 1 : 0);

    const positions = new Map<string, NodePlacement>();
    placed.forEach((n, i) => positions.set(n.elementId, { x: slotX(i), y: cardY, w: LANE_CARD_W, h: LANE_CARD_H, lane: PLACED_LANE }));
    unplaced.forEach((n, k) => positions.set(n.elementId, { x: slotX(unplacedStart + k), y: cardY, w: LANE_CARD_W, h: LANE_CARD_H, lane: UNPLACED_LANE }));

    const bands: LaneBand[] = [];
    const rowH = LANE_HEADER_H + LANE_GAP + LANE_CARD_H + LANE_GAP;
    bands.push({ key: PLACED_LANE, label: words.axis, x: TIMELINE_LABEL_W - LANE_GAP / 2, y: 0, w: Math.max(1, placed.length) * slotW, h: rowH, role: 'axis' });
    if (unplaced.length > 0) {
        bands.push({ key: UNPLACED_LANE, label: words.unplaced, x: slotX(unplacedStart) - LANE_GAP / 2, y: 0, w: unplaced.length * slotW, h: rowH, role: 'unplaced' });
    }

    // Character lanes: everyone taking part in an event on the map, in the
    // order of their first placed event (then the unplaced, then by name).
    // ONE pass over the events and their participants gathers each
    // character's events in sequence order, so the layout is linear in the
    // participant links (a lane per character times every event would be
    // characters × events: a second for a book with thousands of each).
    const participants = options.participants ?? new Map<string, readonly Participant[]>();
    const first = new Map<string, { at: number; who: Participant; events: string[] }>();
    seq.forEach((n, i) => {
        for (const p of participants.get(n.elementId) ?? []) {
            const seen = first.get(p.id);
            if (!seen) first.set(p.id, { at: i, who: p, events: [n.elementId] });
            else if (seen.events[seen.events.length - 1] !== n.elementId) seen.events.push(n.elementId);
        }
    });
    const characters = [...first.values()].sort((a, b) => a.at - b.at || (a.who.name < b.who.name ? -1 : a.who.name > b.who.name ? 1 : 0) || compareRanks(a.who.id, b.who.id));
    const lanesTop = rowH + LANE_GAP;
    const width = slotX(unplacedStart + unplaced.length) - TIMELINE_LABEL_W;
    const marks: LaneMark[] = [];
    characters.forEach(({ who, events }, i) => {
        const y = lanesTop + i * TIMELINE_LANE_H;
        bands.push({ key: `character:${who.id}`, label: who.name, x: 0, y, w: TIMELINE_LABEL_W + Math.max(width, slotW), h: TIMELINE_LANE_H, role: 'character' });
        for (const elementId of events) {
            const at = positions.get(elementId)!;
            marks.push({ characterId: who.id, elementId, x: at.x + at.w / 2, y: y + TIMELINE_LANE_H / 2 });
        }
    });
    return { map: 'TIMELINE', positions, sequences: new Map([[PLACED_LANE, placed], [UNPLACED_LANE, unplaced]]), bands, marks };
}

/** The layout of a derived map, or null for the relationship map (its nodes sit where the author put them). */
export function deriveLaneLayout(map: StoryMapKindValue, nodes: readonly LaneNodeInput[], options: LaneLayoutOptions = {}): LaneLayout | null {
    if (map === 'PLOT') return plotLayout(nodes, options);
    if (map === 'TIMELINE') return timelineLayout(nodes, options);
    return null;
}

/** An order move a drop asks for: the placed neighbours either side, and a beat's new act. */
export interface DropMove {
    elementId: string;
    after: string | null;
    before: string | null;
    /** Set only when a beat changes act. */
    act?: string;
}

/**
 * Where a card dropped with its centre at `point` asks to go, or null when it
 * asks for nothing (back in its own place, in no lane, or a placed timeline
 * event dropped among the unplaced: a drag places an event, never unplaces
 * one). The neighbours are the PLACED cards either side of the drop in the
 * lane shown — never an unplaced one, which has no rank to sit beside.
 */
export function dropTarget(layout: LaneLayout, elementId: string, point: { x: number; y: number }, current: { act: string | null; orderRank: string | null }): DropMove | null {
    const self = layout.positions.get(elementId);
    if (!self) return null;

    let laneKey: string;
    if (layout.map === 'PLOT') {
        const band = layout.bands.find((b) => b.role === 'act' && point.x >= b.x && point.x < b.x + b.w);
        if (!band) return null;
        // A beat is never moved INTO the no-act lane: an act is cleared on its page.
        if (band.key === NO_ACT_LANE && self.lane !== NO_ACT_LANE) return null;
        laneKey = band.key;
    } else {
        const unplaced = layout.bands.find((b) => b.role === 'unplaced');
        if (unplaced && point.x >= unplaced.x) {
            return null;
        }
        laneKey = PLACED_LANE;
    }

    const seq = (layout.sequences.get(laneKey) ?? []).filter((n) => n.elementId !== elementId);
    const axisOf = (id: string) => {
        const p = layout.positions.get(id)!;
        return layout.map === 'PLOT' ? p.y + p.h / 2 : p.x + p.w / 2;
    };
    const along = layout.map === 'PLOT' ? point.y : point.x;
    let index = seq.findIndex((n) => axisOf(n.elementId) > along);
    if (index === -1) index = seq.length;
    const placedCount = seq.filter((n) => n.orderRank !== null).length;
    const at = Math.min(index, placedCount);
    const after = at > 0 ? seq[at - 1].elementId : null;
    const before = at < placedCount ? seq[at].elementId : null;

    const act = layout.map === 'PLOT' && laneKey !== NO_ACT_LANE && laneKey !== current.act ? laneKey : undefined;
    // Already there: placed, in the same lane, between the same two.
    if (act === undefined && current.orderRank !== null && laneKey === self.lane) {
        const own = layout.sequences.get(laneKey) ?? [];
        const i = own.findIndex((n) => n.elementId === elementId);
        const was = { after: i > 0 ? own[i - 1].elementId : null, before: own[i + 1]?.orderRank != null ? own[i + 1].elementId : null };
        if (was.after === after && was.before === before) return null;
    }
    return { elementId, after, before, ...(act !== undefined ? { act } : {}) };
}

/**
 * A one-step move for the keyboard (the element sheet's "Earlier" and "Later",
 * the list-view equivalent of a drag): the neighbours that put a placed
 * element one place earlier or later in its lane, or null at an end. An
 * unplaced element is placed at the end of its lane's placed run by "Later".
 */
export function stepMove(layout: LaneLayout, elementId: string, direction: 'earlier' | 'later'): DropMove | null {
    const self = layout.positions.get(elementId);
    if (!self) return null;
    const seq = layout.sequences.get(self.lane) ?? [];
    const placed = seq.filter((n) => n.orderRank !== null);
    const i = placed.findIndex((n) => n.elementId === elementId);
    if (i === -1) {
        // Not placed yet: "Later" places it after the last placed card of its lane (the timeline: of the axis).
        if (direction === 'earlier') return null;
        const pool = layout.map === 'TIMELINE' ? (layout.sequences.get(PLACED_LANE) ?? []) : placed;
        const last = pool.length > 0 ? pool[pool.length - 1].elementId : null;
        return { elementId, after: last, before: null };
    }
    if (direction === 'earlier') {
        if (i === 0) return null;
        return { elementId, after: i >= 2 ? placed[i - 2].elementId : null, before: placed[i - 1].elementId };
    }
    if (i === placed.length - 1) return null;
    return { elementId, after: placed[i + 1].elementId, before: i + 2 < placed.length ? placed[i + 2].elementId : null };
}
