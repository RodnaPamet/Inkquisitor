/**
 * A bible relation drawn on a story map, as a tldraw BINDING, not an arrow.
 *
 * Carved from inflect-compliance's `process-edge-binding.ts`
 * (docs/carve-manifest.md). A MapEdge is a row that names a BibleRelation;
 * an arrow is a drawing between two points. So the edge carries its
 * persisted fields as binding props and `fromId` / `toId` name the node
 * shapes at its ends. The edge controls inflect hangs off a process edge are
 * gone: a story edge carries nothing but the relation it draws.
 *
 * ═══ THE RELATION, NOT THE ARROW, DECIDES THE DIRECTION ═══
 *
 * `sourceElementId` / `targetElementId` are the relation's own `from` and
 * `to`: an arrow drawn the other way round still draws the relation as it is
 * stored (the server refuses an edge that disagrees with its relation).
 */
import { T, type Editor, type RecordProps, type TLBaseBinding, type TLShapeId } from 'tldraw';

import { STORY_EDGE_BINDING_TYPE, STORY_NODE_SHAPE_TYPE } from '@/lib/canvas/shape-types';

export { STORY_EDGE_BINDING_TYPE };

export type StoryEdgeBindingProps = {
    relationId: string;
    sourceElementId: string;
    targetElementId: string;
};

export type StoryEdgeBinding = TLBaseBinding<typeof STORY_EDGE_BINDING_TYPE, StoryEdgeBindingProps>;

export const storyEdgeBindingProps: RecordProps<StoryEdgeBinding> = {
    relationId: T.string,
    sourceElementId: T.string,
    targetElementId: T.string,
};

/** `relationId` → the binding id it always produces. Deterministic, like the shapes. */
export function bindingIdForRelation(relationId: string): string {
    return `binding:${relationId}`;
}

/**
 * A binding's endpoints as element ids, read through the shapes it binds —
 * the same resolution `tldrawToRows` applies on save. The props are a
 * denormalised copy and can be stale (a duplicated pair of nodes would copy
 * the binding with its originals' ids), so every live reader goes through here.
 */
export function edgeEndpointIds(
    editor: Pick<Editor, 'getShape'>,
    binding: { fromId: string; toId: string; props: { sourceElementId: string; targetElementId: string } },
): { sourceElementId: string; targetElementId: string } {
    const idOf = (shapeId: string): string | null => {
        const s = editor.getShape(shapeId as TLShapeId) as { type?: string; props?: { elementId?: unknown } } | undefined;
        if (!s || s.type !== STORY_NODE_SHAPE_TYPE) return null;
        return typeof s.props?.elementId === 'string' ? s.props.elementId : null;
    };
    return {
        sourceElementId: idOf(binding.fromId) ?? binding.props.sourceElementId,
        targetElementId: idOf(binding.toId) ?? binding.props.targetElementId,
    };
}
