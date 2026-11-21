/**
 * Auto-layout, driven from a tldraw editor.
 *
 * Carved from inflect-compliance's `auto-layout-host.ts`
 * (docs/carve-manifest.md), dagre only (decision D18). The engine
 * (`src/lib/canvas/canvas-auto-layout.ts`) is pure; this is the half that
 * reads nodes and edges out of a store and writes positions back, in SHAPE
 * id space (the ids `updateShapes` needs).
 *
 * OFF THE MAIN THREAD (Phase 3.H): the layout itself runs in a Web Worker
 * (`layoutOffMainThread`), so arranging a full map does not freeze the
 * canvas; the store is read before and written after, on the main thread.
 * A node removed while the worker ran is not written back.
 */
import type { Editor, TLShapeId } from 'tldraw';

import type { AutoLayoutDirection, LayoutEdge, LayoutNode } from '@/lib/canvas/canvas-auto-layout';
import { layoutOffMainThread, type LayoutWorkerFactory } from '@/lib/canvas/auto-layout-off-thread';
import { STORY_EDGE_BINDING_TYPE } from './story-edge-binding';
import { STORY_NODE_SHAPE_TYPE } from './story-node-shape';

interface StoreShape {
    id: string;
    type?: string;
    x: number;
    y: number;
    props?: { w?: unknown; h?: unknown };
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** Every story node on the current page, as the engine wants it. */
export function layoutNodesFrom(editor: Editor): LayoutNode[] {
    return (editor.getCurrentPageShapes() as unknown as StoreShape[])
        .filter((s) => s.type === STORY_NODE_SHAPE_TYPE)
        .map((s) => ({ id: s.id, position: { x: s.x, y: s.y }, width: num(s.props?.w), height: num(s.props?.h) }));
}

/** Every story edge whose two ends are on the page, in shape id space. */
export function layoutEdgesFrom(editor: Editor): LayoutEdge[] {
    const onPage = new Set(editor.getCurrentPageShapes().map((s) => String(s.id)));
    return editor.store
        .allRecords()
        .filter((r) => r.typeName === 'binding' && (r as { type?: string }).type === STORY_EDGE_BINDING_TYPE)
        .map((r) => r as unknown as { fromId: string; toId: string })
        .filter((b) => onPage.has(b.fromId) && onPage.has(b.toId))
        .map((b) => ({ source: b.fromId, target: b.toId }));
}

/** Shape ids of the selected story nodes. */
export function selectedNodeIds(editor: Editor): Set<string> {
    return new Set((editor.getSelectedShapes() as unknown as StoreShape[]).filter((s) => s.type === STORY_NODE_SHAPE_TYPE).map((s) => s.id));
}

/** Write positions back in ONE `updateShapes` call: one store operation, one undo step. A node no longer on the canvas is skipped. */
export function applyLayout(editor: Editor, positions: Record<string, { x: number; y: number }>): number {
    const updates = Object.entries(positions)
        .filter(([id]) => editor.getShape(id as TLShapeId) !== undefined)
        .map(([id, p]) => ({ id: id as TLShapeId, type: STORY_NODE_SHAPE_TYPE, x: p.x, y: p.y }));
    if (updates.length === 0) return 0;
    editor.updateShapes(updates as never);
    return updates.length;
}

export type AutoLayoutScope = 'all' | 'selection';

/**
 * Lay the map out and apply it; answers how many nodes moved, and where the
 * layout ran (null when nothing was laid out). A selection of
 * fewer than two nodes is not arranged (one node laid out alone is flung to
 * its own origin). The layout runs in a worker where there is one
 * (`createWorker`, the browser's by default), and the positions are applied
 * as one store operation (one undo step) when it answers.
 */
export async function runAutoLayout(
    editor: Editor,
    direction: AutoLayoutDirection,
    scope: AutoLayoutScope = 'all',
    options: { createWorker?: LayoutWorkerFactory } = {},
): Promise<{ moved: number; thread: 'worker' | 'main' | null }> {
    const filter = scope === 'selection' ? selectedNodeIds(editor) : undefined;
    if (filter && filter.size < 2) return { moved: 0, thread: null };
    const job = { nodes: layoutNodesFrom(editor), edges: layoutEdgesFrom(editor), direction, ...(filter ? { nodeIds: [...filter] } : {}) };
    const { positions, thread } = await layoutOffMainThread(job, options.createWorker);
    editor.markHistoryStoppingPoint('arrange');
    return { moved: applyLayout(editor, positions), thread };
}
