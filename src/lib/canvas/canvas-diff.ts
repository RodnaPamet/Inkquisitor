/**
 * The difference between two states of a story map — what the history's
 * diff overlay shows.
 *
 * Carved from inflect-compliance's `canvas-diff.ts`
 * (docs/carve-manifest.md), on the story map's rows: nodes match by the
 * element they draw, edges by the relation they draw.
 *
 *   added      in `next`, not in `base`
 *   removed    in `base`, not in `next`
 *   moved      a node whose position alone changed (beyond half a unit)
 *   modified   a node whose size or lane changed (with or without a move);
 *              an edge whose ends changed
 *   unchanged  the same
 *
 * The freeform layer is compared as a whole (`freeformChanged`): its records
 * are the renderer's, and naming them one by one would read out sticky notes
 * as ids. Pure, client-safe.
 */
import type { MapState } from './map-state';

export type DiffClass = 'added' | 'removed' | 'moved' | 'modified' | 'unchanged';

export interface CanvasDiff {
    nodes: Map<string, DiffClass>;
    edges: Map<string, DiffClass>;
    freeformChanged: boolean;
    summary: {
        nodesAdded: number;
        nodesRemoved: number;
        nodesMoved: number;
        nodesModified: number;
        edgesAdded: number;
        edgesRemoved: number;
        edgesModified: number;
    };
}

const EPSILON = 0.5;
const differs = (a: number, b: number) => Math.abs(a - b) > EPSILON;

type DiffState = Pick<MapState, 'nodes' | 'edges'> & { freeform?: MapState['freeform'] };

export function computeCanvasDiff(base: DiffState, next: DiffState): CanvasDiff {
    const nodes = new Map<string, DiffClass>();
    const edges = new Map<string, DiffClass>();
    const summary = { nodesAdded: 0, nodesRemoved: 0, nodesMoved: 0, nodesModified: 0, edgesAdded: 0, edgesRemoved: 0, edgesModified: 0 };

    const nextNodes = new Map(next.nodes.map((n) => [n.elementId, n]));
    const baseNodes = new Map(base.nodes.map((n) => [n.elementId, n]));
    for (const [id, a] of baseNodes) {
        const b = nextNodes.get(id);
        if (!b) {
            nodes.set(id, 'removed');
            summary.nodesRemoved += 1;
            continue;
        }
        const moved = differs(a.x, b.x) || differs(a.y, b.y);
        const reshaped = differs(a.w, b.w) || differs(a.h, b.h) || (a.lane ?? null) !== (b.lane ?? null);
        const c: DiffClass = reshaped ? 'modified' : moved ? 'moved' : 'unchanged';
        nodes.set(id, c);
        if (c === 'moved') summary.nodesMoved += 1;
        if (c === 'modified') summary.nodesModified += 1;
    }
    for (const id of nextNodes.keys()) {
        if (!baseNodes.has(id)) {
            nodes.set(id, 'added');
            summary.nodesAdded += 1;
        }
    }

    const nextEdges = new Map(next.edges.map((e) => [e.relationId, e]));
    const baseEdges = new Map(base.edges.map((e) => [e.relationId, e]));
    for (const [id, a] of baseEdges) {
        const b = nextEdges.get(id);
        if (!b) {
            edges.set(id, 'removed');
            summary.edgesRemoved += 1;
            continue;
        }
        const c: DiffClass = a.sourceElementId === b.sourceElementId && a.targetElementId === b.targetElementId ? 'unchanged' : 'modified';
        edges.set(id, c);
        if (c === 'modified') summary.edgesModified += 1;
    }
    for (const id of nextEdges.keys()) {
        if (!baseEdges.has(id)) {
            edges.set(id, 'added');
            summary.edgesAdded += 1;
        }
    }

    const freeformChanged = JSON.stringify(base.freeform ?? []) !== JSON.stringify(next.freeform ?? []);
    return { nodes, edges, freeformChanged, summary };
}

/** How many changes a diff holds, the freeform layer counting as one. */
export function diffChangeCount(diff: CanvasDiff): number {
    const s = diff.summary;
    return s.nodesAdded + s.nodesRemoved + s.nodesMoved + s.nodesModified + s.edgesAdded + s.edgesRemoved + s.edgesModified + (diff.freeformChanged ? 1 : 0);
}
