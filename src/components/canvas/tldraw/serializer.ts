/**
 * rows ⇄ tldraw. The persistence contract for the story canvas.
 *
 * Carved from inflect-compliance's `serializer.ts` (docs/carve-manifest.md),
 * with the contract kept and the process taxonomy, node keys and edge
 * controls gone: a node is keyed by the element it draws and an edge by the
 * relation it draws.
 *
 * ═══ THE ONE RESULT THE CANVAS DEPENDS ON ═══
 *
 * `tldrawToRows(rowsToTldraw(x))` must reproduce `x` exactly. If a load/save
 * cycle with no edit did not produce an identical row set, every autosave
 * would write a spurious version and every diff would be noise. The server
 * compares states too and writes nothing for an identical one, but the
 * contract is held here, where it is cheap to test
 * (`tests/unit/canvas/serializer-round-trip.test.ts`).
 *
 * ═══ ROWS STAY THE SOURCE OF TRUTH ═══
 *
 * The map is MapNode / MapEdge rows that name bible elements and relations.
 * This module projects them into records a renderer can draw and back; it
 * never makes the renderer's document authoritative.
 *
 * ═══ THREE PLACES A ROUND TRIP NORMALLY ACQUIRES A DIFFERENCE ═══
 *
 * 1. `undefined` vs `null`: every optional is `?? null` on BOTH sides.
 * 2. GEOMETRY: position lives on the shape (`x` / `y`), never in props.
 * 3. FREEFORM: sticky notes and drawings are not nodes. They travel out to
 *    `StoryMap.freeformJson` and back, and never become rows; the edge LINE,
 *    which is derived, is neither a row nor freeform (`derived`).
 *
 * The SHOWN props (name, kind label, badge; an edge's label) come in beside
 * the rows (`MapDisplay`) and are dropped on the way back: they are the
 * bible's, not the map's.
 */
import type { MapEdgeRow, MapNodeRow } from '@/lib/canvas/map-state';
import { STORY_EDGE_BINDING_TYPE, STORY_EDGE_SHAPE_TYPE, STORY_NODE_SHAPE_TYPE } from '@/lib/canvas/shape-types';
import { shapeIdForElement, type NodeBadgeTone, type StoryNodeShapeProps } from './story-node-shape';
import { bindingIdForRelation, type StoryEdgeBindingProps } from './story-edge-binding';
import { describeRefusal, validateEdge, type EdgeRefusal } from './edge-validation';

/** The normalised graph, exactly as the save payload carries it. */
export interface GraphRows {
    nodes: MapNodeRow[];
    edges: MapEdgeRow[];
}

/** What a node shows, by element id. */
export interface NodeDisplay {
    name: string;
    kindLabel: string;
    badgeLabel: string;
    badgeTone: NodeBadgeTone;
}

/** What the canvas shows beside the rows; resolved by the host from the bible. */
export interface MapDisplay {
    nodes: ReadonlyMap<string, NodeDisplay>;
    /** An edge's label, by relation id. */
    edgeLabels: ReadonlyMap<string, string>;
}

export const EMPTY_DISPLAY: MapDisplay = { nodes: new Map(), edgeLabels: new Map() };

const UNKNOWN_NODE_DISPLAY: NodeDisplay = { name: '', kindLabel: '', badgeLabel: '', badgeTone: 'none' };

/**
 * Anything on the canvas that is not a node or an edge. Opaque on purpose:
 * the projection carries these without understanding them.
 */
export interface FreeformRecord {
    id: string;
    type: string;
    [k: string]: unknown;
}

/**
 * What this module produces and consumes — the fields the ROW determines,
 * which is exactly what tldraw's create APIs accept as a partial. NOT a full
 * `TLShape`; `id` is a plain string, branded at the editor boundary.
 */
export interface StoryNodeShapeRecord {
    id: string;
    type: typeof STORY_NODE_SHAPE_TYPE;
    x: number;
    y: number;
    props: StoryNodeShapeProps;
}

export interface StoryEdgeBindingRecord {
    id: string;
    type: typeof STORY_EDGE_BINDING_TYPE;
    fromId: string;
    toId: string;
    props: StoryEdgeBindingProps;
}

export interface TldrawGraph {
    shapes: StoryNodeShapeRecord[];
    bindings: StoryEdgeBindingRecord[];
    /** Persisted to `StoryMap.freeformJson`, never to a row. */
    freeform: FreeformRecord[];
}

/** Raised when a binding names an edge the map cannot hold. */
export class EdgeEndpointError extends Error {
    constructor(
        readonly relationId: string,
        readonly refusals: EdgeRefusal[],
    ) {
        super(`edge ${relationId || '(unkeyed)'} was refused: ` + refusals.map((r) => `${r.code} — ${describeRefusal(r)}`).join('; '));
        this.name = 'EdgeEndpointError';
    }
}

/** Anything a canvas can hand back. */
export type CanvasRecord = StoryNodeShapeRecord | StoryEdgeBindingRecord | FreeformRecord;

export const isStoryNodeShape = (r: CanvasRecord): r is StoryNodeShapeRecord => r.type === STORY_NODE_SHAPE_TYPE;
export const isStoryEdgeBinding = (r: CanvasRecord): r is StoryEdgeBindingRecord => r.type === STORY_EDGE_BINDING_TYPE;
/** The drawn half of an edge: derived on load, never persisted (see `derived`). */
export const isStoryEdgeShape = (r: CanvasRecord): boolean => r.type === STORY_EDGE_SHAPE_TYPE;

/**
 * The node props `tldrawToRows` reads — the persisted set. A change to any
 * other prop (the shown name, kind label or badge) cannot reach a row, so a
 * change handler that treats it as an edit would mark the map dirty for
 * nothing. `canvas-changes-tldraw.ts` compares only these keys, and
 * `tests/unit/canvas/persisted-props-match-the-projection.test.ts` derives the
 * set from what the projection actually reads.
 */
export const PERSISTED_NODE_PROPS = ['elementId', 'h', 'lane', 'w'] as const;
export type PersistedNodeProp = (typeof PERSISTED_NODE_PROPS)[number];

/** The binding props the edge projection reads: all of them. */
export const PERSISTED_EDGE_PROPS = ['relationId', 'sourceElementId', 'targetElementId'] as const;
export type PersistedEdgeProp = (typeof PERSISTED_EDGE_PROPS)[number];

// ─── rows → tldraw ─────────────────────────────────────────────────────

export function rowsToTldraw(rows: GraphRows, display: MapDisplay = EMPTY_DISPLAY, freeform: FreeformRecord[] = []): TldrawGraph {
    return {
        freeform,
        shapes: rows.nodes.map((n) => {
            const shown = display.nodes.get(n.elementId) ?? UNKNOWN_NODE_DISPLAY;
            return {
                id: shapeIdForElement(n.elementId),
                type: STORY_NODE_SHAPE_TYPE,
                // POSITION LIVES HERE and nowhere else.
                x: n.x,
                y: n.y,
                props: {
                    w: n.w,
                    h: n.h,
                    elementId: n.elementId,
                    lane: n.lane ?? null,
                    name: shown.name,
                    kindLabel: shown.kindLabel,
                    badgeLabel: shown.badgeLabel,
                    badgeTone: shown.badgeTone,
                },
            };
        }),
        bindings: rows.edges.map((e) => ({
            id: bindingIdForRelation(e.relationId),
            type: STORY_EDGE_BINDING_TYPE,
            fromId: shapeIdForElement(e.sourceElementId),
            toId: shapeIdForElement(e.targetElementId),
            props: {
                relationId: e.relationId,
                sourceElementId: e.sourceElementId,
                targetElementId: e.targetElementId,
            },
        })),
    };
}

// ─── tldraw → rows ─────────────────────────────────────────────────────

/**
 * Split a canvas into the structured graph and everything else. The filter
 * IS the contract: a real store hands back everything on the canvas, so this
 * is the only place that decides a sticky note is not a node.
 */
export function partitionCanvas(records: readonly CanvasRecord[]): {
    shapes: StoryNodeShapeRecord[];
    bindings: StoryEdgeBindingRecord[];
    freeform: FreeformRecord[];
    /** Records rebuilt on load (the edge lines), which nothing may persist. */
    derived: FreeformRecord[];
} {
    const shapes: StoryNodeShapeRecord[] = [];
    const bindings: StoryEdgeBindingRecord[] = [];
    const freeform: FreeformRecord[] = [];
    const derived: FreeformRecord[] = [];
    for (const r of records) {
        if (isStoryNodeShape(r)) shapes.push(r);
        else if (isStoryEdgeBinding(r)) bindings.push(r);
        else if (isStoryEdgeShape(r)) derived.push(r as FreeformRecord);
        else freeform.push(r);
    }
    return { shapes, bindings, freeform, derived };
}

export function tldrawToRows(graph: TldrawGraph): GraphRows {
    // Only node shapes become rows; `partitionCanvas` is what makes the type true.
    const shapes = graph.shapes.filter(isStoryNodeShape);

    /**
     * Element id by shape id — the ONLY correct way to resolve an endpoint.
     * A node's id is derived from its element, but a duplicated or pasted one
     * gets a fresh id; the shape's own `props.elementId` is authoritative.
     */
    const elementByShapeId = new Map(shapes.map((s) => [String(s.id), s.props.elementId]));
    const elementIds = new Set(shapes.map((s) => s.props.elementId));

    const resolved = graph.bindings.map((b) => ({
        relationId: b.props.relationId,
        sourceElementId: elementByShapeId.get(String(b.fromId)) ?? '',
        targetElementId: elementByShapeId.get(String(b.toId)) ?? '',
    }));
    resolved.forEach((edge, i) => {
        const b = graph.bindings[i];
        // The graph's OTHER edges, so an edge is not a duplicate of itself.
        const others = new Set(resolved.filter((_, j) => j !== i).map((e) => e.relationId));
        // The relation's own ends are what the binding was created with.
        const relation = { relationId: b.props.relationId, sourceElementId: b.props.sourceElementId, targetElementId: b.props.targetElementId };
        const refusals = validateEdge(edge, elementIds, others, relation);
        if (refusals.length > 0) throw new EdgeEndpointError(b.props.relationId, refusals);
    });

    return {
        nodes: shapes.map((s) => ({
            elementId: s.props.elementId,
            // GEOMETRY FROM THE SHAPE.
            x: s.x,
            y: s.y,
            w: s.props.w,
            h: s.props.h,
            lane: s.props.lane ?? null,
        })),
        edges: resolved,
    };
}
