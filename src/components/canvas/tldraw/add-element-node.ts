/**
 * Put one bible element on the map (Phase 3.1): a node at the centre of the
 * view, or — when the element is already on the map — that node selected and
 * brought into view, since an element appears on a map at most once.
 *
 * One `editor.run`, so adding a node is one undoable step; the store listener
 * sees a node added and marks the map dirty, which is what saves it.
 */
import type { Editor, TLShapeId } from 'tldraw';

import { NODE_DEFAULT_H, NODE_DEFAULT_W } from '@/lib/canvas/limits';
import type { NodeDisplay } from './serializer';
import { STORY_NODE_SHAPE_TYPE, shapeIdForElement } from './story-node-shape';

export function addElementNode(editor: Editor, elementId: string, display: NodeDisplay): { added: boolean; shapeId: TLShapeId } {
    const existing = editor
        .getCurrentPageShapes()
        .find((s) => s.type === STORY_NODE_SHAPE_TYPE && (s.props as { elementId?: unknown }).elementId === elementId);
    if (existing) {
        editor.select(existing.id);
        const bounds = editor.getShapePageBounds(existing.id);
        if (bounds) editor.zoomToBounds(bounds, { targetZoom: 1, animation: { duration: 0 } });
        return { added: false, shapeId: existing.id };
    }
    const centre = editor.getViewportPageBounds().center;
    const shapeId = shapeIdForElement(elementId) as TLShapeId;
    editor.run(() => {
        editor.createShapes([
            {
                id: shapeId,
                type: STORY_NODE_SHAPE_TYPE,
                x: Math.round(centre.x - NODE_DEFAULT_W / 2),
                y: Math.round(centre.y - NODE_DEFAULT_H / 2),
                props: { w: NODE_DEFAULT_W, h: NODE_DEFAULT_H, elementId, lane: null, ...display },
            },
        ] as never);
        editor.select(shapeId);
    });
    return { added: true, shapeId };
}
