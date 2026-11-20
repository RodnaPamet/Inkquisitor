/**
 * A bible element drawn on a story map, as a tldraw shape — its type, its
 * props and the mapping between a shape id and the element it draws.
 *
 * Carved from inflect-compliance's `process-node-shape.ts`
 * (docs/carve-manifest.md), with the process-node taxonomy gone: a node here
 * is ONE BibleElement, and an element appears on a map at most once, so the
 * element's id is the node's key.
 *
 * ═══ TWO KINDS OF PROPS: PERSISTED AND SHOWN ═══
 *
 * PERSISTED (`PERSISTED_NODE_PROPS` in the serializer): `elementId`, `w`,
 * `h`, `lane` — with `x` / `y` on the shape itself, which is the only home
 * position has. A resize IS saved here (the MapNode row has `w` / `h`),
 * which inflect's process node could not do and so locked.
 *
 * SHOWN: `name`, `kindLabel`, `badgeLabel`, `badgeTone` are the element's
 * name, its kind's label and its completeness badge, resolved by the HOST
 * (which has a translator; a shape util has none) from the bible and
 * re-derived on every load. They never reach a row: renaming an element is a
 * bible edit, never a canvas edit, so a change to one of them is not an edit
 * worth saving (`canvas-changes-tldraw.ts` compares the persisted props only).
 */
import { T, createShapeId, type RecordProps, type TLBaseShape } from 'tldraw';

import { NODE_DEFAULT_H, NODE_DEFAULT_W } from '@/lib/canvas/limits';
import { STORY_NODE_SHAPE_TYPE } from '@/lib/canvas/shape-types';

export { STORY_NODE_SHAPE_TYPE };

/** How the completeness badge is drawn: no bar, part filled, every field filled. */
export type NodeBadgeTone = 'none' | 'partial' | 'complete';

export type StoryNodeShapeProps = {
    w: number;
    h: number;
    elementId: string;
    lane: string | null;
    name: string;
    kindLabel: string;
    badgeLabel: string;
    badgeTone: NodeBadgeTone;
};

export type StoryNodeShape = TLBaseShape<typeof STORY_NODE_SHAPE_TYPE, StoryNodeShapeProps>;

/**
 * Runtime validators. A shape can arrive from a stored document rather than
 * this build's code, so the types say what we intend and these say what
 * tldraw will accept.
 */
export const storyNodeShapeProps: RecordProps<StoryNodeShape> = {
    w: T.nonZeroNumber,
    h: T.nonZeroNumber,
    elementId: T.string,
    lane: T.string.nullable(),
    name: T.string,
    kindLabel: T.string,
    badgeLabel: T.string,
    badgeTone: T.literalEnum('none', 'partial', 'complete'),
};

export { NODE_DEFAULT_H, NODE_DEFAULT_W };

/** The prefix `createShapeId` stamps. Derived, never hardcoded in logic. */
const SHAPE_PREFIX = String(createShapeId(''));

/**
 * `elementId` → the shape id it always produces. Deterministic, so a
 * load/save cycle with no edit reproduces the same ids and a freeform arrow
 * bound to a node finds it again on the next load.
 */
export function shapeIdForElement(elementId: string): string {
    return String(createShapeId(elementId));
}

/** The inverse, or null for an id this mapping did not produce. */
export function elementIdFromShapeId(shapeId: string): string | null {
    if (!shapeId.startsWith(SHAPE_PREFIX)) return null;
    const rest = shapeId.slice(SHAPE_PREFIX.length);
    return rest.length > 0 && !rest.startsWith('edge-') ? rest : null;
}
