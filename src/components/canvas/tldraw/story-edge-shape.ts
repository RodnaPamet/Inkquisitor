/**
 * The DRAWN half of a story edge.
 *
 * Carved from inflect-compliance's `process-edge-shape.ts`
 * (docs/carve-manifest.md), without the process variants and automation
 * kinds: a story edge is one solid line, labelled with its relation.
 *
 * ═══ WHY TWO RECORDS FOR ONE EDGE ═══
 *
 * A `BindingUtil` cannot draw (it has lifecycle hooks and no `component()`),
 * so the binding owns identity — `relationId` and the two element ids, what
 * the serializer reads — and this SHAPE owns pixels, hit-testing and
 * selectability. It is DERIVED: rebuilt from the bindings on every load and
 * never persisted. `partitionCanvas` sorts it into a `derived` bucket that
 * nothing writes; left in the default `freeform` arm it would be saved, then
 * re-derived AND restored on the next load, doubling on every save.
 *
 * `dx` / `dy` (the offset to the far endpoint) and `label` are derived too,
 * which is why resize is refused: a capability whose result cannot be saved
 * reports success and discards.
 */
import { T, type RecordProps, type TLBaseShape, type TLShapeId } from 'tldraw';

import { STORY_EDGE_SHAPE_TYPE } from '@/lib/canvas/shape-types';

export { STORY_EDGE_SHAPE_TYPE };

export type StoryEdgeShapeProps = {
    /** The relation this line draws (the binding's `relationId`). */
    relationId: string;
    /** The relation type's label, copied from the bible on load. `''` for none. */
    label: string;
    /** Offset from this shape's origin to the far endpoint. Derived. */
    dx: number;
    dy: number;
};

export type StoryEdgeShape = TLBaseShape<typeof STORY_EDGE_SHAPE_TYPE, StoryEdgeShapeProps>;

export const storyEdgeShapeProps: RecordProps<StoryEdgeShape> = {
    relationId: T.string,
    label: T.string,
    dx: T.number,
    dy: T.number,
};

const EDGE_SHAPE_PREFIX = 'shape:edge-';

/** A stable shape id for a relation: seeding twice must not draw two lines. */
export function shapeIdForRelation(relationId: string): TLShapeId {
    return `${EDGE_SHAPE_PREFIX}${relationId}` as TLShapeId;
}

/** The inverse, for resolving a selected line back to its relation. */
export function relationIdFromShapeId(id: string): string | null {
    return id.startsWith(EDGE_SHAPE_PREFIX) ? id.slice(EDGE_SHAPE_PREFIX.length) : null;
}

/** The minimum of tldraw's `Box` this module needs. */
export interface CentredBounds {
    center: { x: number; y: number };
}

/**
 * Where an edge line sits, given its two endpoints' bounds. Shared by the
 * seed on load and the reposition when a node moves, so the two agree.
 */
export function edgeLineGeometry(from: CentredBounds, to: CentredBounds): { x: number; y: number; dx: number; dy: number } {
    return { x: from.center.x, y: from.center.y, dx: to.center.x - from.center.x, dy: to.center.y - from.center.y };
}
