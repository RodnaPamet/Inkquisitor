/**
 * What a story map previews of the book's PENDING structural proposals
 * (Phase 3.3, decision D24), as pure geometry: a ghost node for each proposed
 * element of a kind the map draws, a ghost edge for each proposed relation
 * whose two ends the map shows (a card, or a ghost), and the places on the
 * plot board where "What happens between these?" can be asked.
 *
 * Nothing here is a canvas record. The ghosts are drawn over the canvas from
 * React state (`GhostLayer`) and never enter tldraw's store, so the
 * serializer, the save and the map's snapshots cannot see them; a ghost is
 * not selectable, not movable and never marks the map dirty. The plain list
 * beside the canvas is the record (`PendingStructureList`): what cannot be
 * drawn here (an end not on this map) is still listed there, and counted
 * (`undrawn`) so the canvas says so rather than hide it.
 *
 * Client-safe: no tldraw, no server module.
 */
import { compareRanks } from '@/lib/bible/story-order';
import type { PendingStructureView } from '@/lib/enrichment/api-client';
import { LANE_CARD_H, LANE_CARD_W, LANE_GAP, type LaneLayout } from './lanes';

export interface PreviewBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface GhostNode extends PreviewBox {
    proposalId: string;
    name: string;
    kind: string;
}

export interface GhostEdge {
    proposalId: string;
    from: { x: number; y: number };
    to: { x: number; y: number };
    label: string;
}

export interface StructurePreview {
    nodes: GhostNode[];
    edges: GhostEdge[];
    /** Pending proposals this map does not draw (another map's kind, or an end not shown here): they are in the list only. */
    undrawn: number;
}

/** At most this many ghosts are drawn (the list holds every one). */
export const GHOSTS_MAX = 60;
/** How far to the side of its neighbours a slot's ghost stands, so it covers neither. */
export const GHOST_SIDE_OFFSET = 32;

const centre = (b: PreviewBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/**
 * The preview for the cards now on the canvas (`boxes`, by element id).
 *
 *   a new element filling a slot   beside its two neighbours, between them
 *                                  (when both are on the map and the slot has
 *                                  not changed: a changed slot's beat goes
 *                                  where the author chooses, D25)
 *   any other new element          in a column to the right of everything
 *   a new relation                 a line between its ends' boxes — a card,
 *                                  or the ghost of a proposed end — and
 *                                  nothing when an end is on neither
 */
export function structurePreview(pending: readonly PendingStructureView[], boxes: ReadonlyMap<string, PreviewBox>, drawnKinds: ReadonlySet<string>): StructurePreview {
    const live = pending.filter((p) => p.status === 'PENDING');
    const nodes: GhostNode[] = [];
    const byProposal = new Map<string, PreviewBox>();
    const all = [...boxes.values()];
    const right = all.length > 0 ? Math.max(...all.map((b) => b.x + b.w)) : 0;
    const top = all.length > 0 ? Math.min(...all.map((b) => b.y)) : 0;
    let column = 0;
    let undrawn = 0;

    for (const p of live) {
        if (p.kind !== 'NEW_ELEMENT') continue;
        if (!drawnKinds.has(p.newKind) || nodes.length >= GHOSTS_MAX) {
            undrawn += 1;
            continue;
        }
        const slot = p.slot && !p.slot.changed ? p.slot : null;
        const after = slot ? boxes.get(slot.afterElementId) : undefined;
        const before = slot ? boxes.get(slot.beforeElementId) : undefined;
        let box: PreviewBox;
        if (after && before) {
            const a = centre(after);
            const b = centre(before);
            box = { x: Math.round(Math.max(after.x + after.w, before.x + before.w) + GHOST_SIDE_OFFSET), y: Math.round((a.y + b.y) / 2 - LANE_CARD_H / 2), w: LANE_CARD_W, h: LANE_CARD_H };
        } else {
            box = { x: Math.round(right + GHOST_SIDE_OFFSET * 2), y: Math.round(top + column * (LANE_CARD_H + LANE_GAP)), w: LANE_CARD_W, h: LANE_CARD_H };
            column += 1;
        }
        byProposal.set(p.id, box);
        nodes.push({ proposalId: p.id, name: p.name, kind: p.newKind, ...box });
    }

    const edges: GhostEdge[] = [];
    for (const p of live) {
        if (p.kind !== 'NEW_RELATION') continue;
        const endBox = (end: { elementId: string | null; proposalId: string | null }) =>
            (end.elementId ? boxes.get(end.elementId) : undefined) ?? (end.proposalId ? byProposal.get(end.proposalId) : undefined);
        const from = endBox(p.from);
        const to = endBox(p.to);
        if (!from || !to || edges.length >= GHOSTS_MAX) {
            undrawn += 1;
            continue;
        }
        edges.push({ proposalId: p.id, from: centre(from), to: centre(to), label: p.label });
    }
    return { nodes, edges, undrawn };
}

/** A place on the plot board between two neighbouring beats of one act lane. */
export interface BetweenSlot {
    afterElementId: string;
    beforeElementId: string;
    afterName: string;
    beforeName: string;
    lane: string;
    /** Where the "What happens between these?" control stands: the gap between the two cards. */
    point: { x: number; y: number };
}

/**
 * Every slot the plot board offers: in each act lane, each two consecutive
 * PLACED beats (the server's own rule: same act, both ranked, the first
 * before the second, no beat of that act between them — a beat of the act
 * that is not on this map makes the server refuse SLOT_INVALID, worded).
 */
export function betweenSlots(layout: LaneLayout | null): BetweenSlot[] {
    if (!layout || layout.map !== 'PLOT') return [];
    const out: BetweenSlot[] = [];
    for (const [lane, sequence] of layout.sequences) {
        const placed = sequence.filter((n) => n.orderRank !== null).sort((a, b) => compareRanks(a.orderRank!, b.orderRank!));
        for (let i = 0; i + 1 < placed.length; i += 1) {
            const a = placed[i];
            const b = placed[i + 1];
            const pa = layout.positions.get(a.elementId);
            const pb = layout.positions.get(b.elementId);
            if (!pa || !pb) continue;
            out.push({
                afterElementId: a.elementId,
                beforeElementId: b.elementId,
                afterName: a.name,
                beforeName: b.name,
                lane,
                point: { x: Math.round((pa.x + pa.w / 2 + pb.x + pb.w / 2) / 2), y: Math.round((pa.y + pa.h + pb.y) / 2) },
            });
        }
    }
    return out;
}

/**
 * A structural proposal accepted from a story map's list, as the map adds it
 * (Phase 3.3): a new element of a kind the map draws becomes a card, a new
 * relation whose two ends are on the map becomes an edge — both through the
 * map's ordinary save, under its version lock. One accepted elsewhere (the
 * review page) is not drawn by any map: it is in the bible, and the author
 * adds it from the picker.
 */
export type AcceptedStructure =
    | { kind: 'NEW_ELEMENT'; elementId: string; name: string; elementKind: string; filledFieldCount: number }
    | { kind: 'NEW_RELATION'; relationId: string; sourceElementId: string; targetElementId: string; label: string };
