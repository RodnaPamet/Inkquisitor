/**
 * Canvas auto-layout via dagre (decision D18: dagre only).
 *
 * Carved from inflect-compliance's `canvas-auto-layout.ts`
 * (docs/carve-manifest.md), with the elkjs force-directed engine removed
 * (EPL-2.0; the owner decided against carrying it) and the annotation and
 * group special cases gone (a story map has neither). `@dagrejs/dagre` is
 * MIT and an npm dependency, not vendored.
 *
 * Stateless: nodes + edges + a direction in, top-left positions out. The
 * host applies them (`auto-layout-host.ts`). Input types are structural, so
 * the layout names no renderer and is tested without one.
 */
import dagre from '@dagrejs/dagre';

import { NODE_DEFAULT_H, NODE_DEFAULT_W } from './limits';

/** The minimum of a positioned node this module reads. */
export interface LayoutNode {
    id: string;
    position: { x: number; y: number };
    /** The node's size, where the host knows it; the defaults otherwise. */
    width?: number;
    height?: number;
}

export interface LayoutEdge {
    source: string;
    target: string;
}

export type AutoLayoutDirection = 'LR' | 'TB';

const RANKSEP = 80;
const NODESEP = 48;

export interface AutoLayoutResult {
    /** New TOP-LEFT positions keyed by node id. */
    positions: Record<string, { x: number; y: number }>;
}

const sizeOr = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/**
 * Hierarchical layout. `nodeIdsFilter` scopes it to a subset (arrange the
 * selection): edges leaving the subset are ignored, other nodes keep their
 * places and are absent from the result, and the subset is re-centred on
 * where it was so it does not jump to the origin.
 */
export function computeAutoLayout(
    nodes: readonly LayoutNode[],
    edges: readonly LayoutEdge[],
    direction: AutoLayoutDirection,
    nodeIdsFilter?: ReadonlySet<string>,
): AutoLayoutResult {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: direction, ranksep: RANKSEP, nodesep: NODESEP, marginx: 32, marginy: 32 });
    g.setDefaultEdgeLabel(() => ({}));

    const participating = new Map<string, LayoutNode>();
    for (const node of nodes) {
        if (nodeIdsFilter && !nodeIdsFilter.has(node.id)) continue;
        g.setNode(node.id, { width: sizeOr(node.width, NODE_DEFAULT_W), height: sizeOr(node.height, NODE_DEFAULT_H) });
        participating.set(node.id, node);
    }
    for (const edge of edges) {
        if (participating.has(edge.source) && participating.has(edge.target) && edge.source !== edge.target) g.setEdge(edge.source, edge.target);
    }
    dagre.layout(g);

    const positions: Record<string, { x: number; y: number }> = {};
    for (const id of participating.keys()) {
        const pos = g.node(id);
        if (!pos) continue;
        // dagre returns CENTRE coordinates; the canvas wants top-left.
        positions[id] = { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 };
    }

    if (nodeIdsFilter && participating.size > 0) {
        let bx = 0;
        let by = 0;
        let ax = 0;
        let ay = 0;
        for (const [id, node] of participating) {
            bx += node.position.x;
            by += node.position.y;
            ax += positions[id]?.x ?? 0;
            ay += positions[id]?.y ?? 0;
        }
        const n = participating.size;
        const dx = bx / n - ax / n;
        const dy = by / n - ay / n;
        for (const id of Object.keys(positions)) positions[id] = { x: positions[id].x + dx, y: positions[id].y + dy };
    }
    return { positions };
}
