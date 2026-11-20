/**
 * A live editor's canvas, projected to the save payload.
 *
 * Carved from inflect-compliance's `editor-canvas.ts`
 * (docs/carve-manifest.md).
 *
 * NOT `store.allRecords()`: that returns camera, instance, pointer and page
 * records too, and anything `partitionCanvas` does not recognise lands in
 * the freeform layer, which IS persisted — the author's camera position
 * would be written into the map on every save. Shapes come from the CURRENT
 * PAGE only (a map is one page), and a binding is kept only when both its
 * endpoints are shapes on that page.
 */
import type { Editor, TLBinding } from 'tldraw';

import { partitionCanvas, tldrawToRows, type CanvasRecord, type FreeformRecord, type GraphRows } from './serializer';
import { STORY_NODE_SHAPE_TYPE } from './story-node-shape';

/** What a save needs: the rows, and the freeform layer beside them. */
export interface EditorCanvas {
    rows: GraphRows;
    freeform: FreeformRecord[];
}

/**
 * Project the editor's current page to rows. Throws `EdgeEndpointError` for
 * an edge the validator refuses, rather than dropping it silently.
 */
export function serializeEditorCanvas(editor: Editor): EditorCanvas {
    const shapes = editor.getCurrentPageShapes();
    const onPage = new Set(shapes.map((s) => String(s.id)));
    const isBinding = (r: { typeName: string }): r is TLBinding => r.typeName === 'binding';
    const bindings = editor.store
        .allRecords()
        .filter(isBinding)
        .filter((b) => onPage.has(String(b.fromId)) && onPage.has(String(b.toId)));

    // SPREAD: a snapshot of the store rather than live references, so an edit
    // made while a save is in flight cannot change what that save writes.
    const records: CanvasRecord[] = [
        ...shapes.map((s) => {
            // A node is saved at its PAGE position: a node dropped inside a
            // frame carries frame-relative x/y, and its row has no frame.
            if (s.type !== STORY_NODE_SHAPE_TYPE || String(s.parentId).startsWith('page:')) return { ...s };
            const point = editor.getShapePageTransform(s.id).point();
            return { ...s, x: point.x, y: point.y };
        }),
        ...bindings.map((b) => ({ ...b })),
    ];
    const partitioned = partitionCanvas(records);
    return { rows: tldrawToRows(partitioned), freeform: partitioned.freeform };
}
