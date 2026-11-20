/**
 * The canvas's pure work at full size, held by COUNTED WORK and its growth,
 * never a wall clock (Phase 3.H, item 2): saving a map of 1,500 edges is
 * linear in its edges, and the layout worker answers each job with exactly
 * the layout the main thread would have made.
 */
import { rowsToTldraw, tldrawToRows, type GraphRows } from '@/components/canvas/tldraw/serializer';
import { computeAutoLayout } from '@/lib/canvas/canvas-auto-layout';
import { layoutOffMainThread, type AutoLayoutReply } from '@/lib/canvas/auto-layout-off-thread';
import { LAYOUT_WORKER_MARKER, installLayoutWorker } from '@/lib/canvas/auto-layout-worker';
import { MAX_MAP_EDGES, MAX_MAP_NODES } from '@/lib/canvas/limits';

function mapOf(nodeCount: number, edgeCount: number): GraphRows {
    const nodes = Array.from({ length: nodeCount }, (_, i) => ({ elementId: `el${i}`, x: i * 10, y: 0, w: 220, h: 88, lane: null }));
    const edges = Array.from({ length: edgeCount }, (_, i) => {
        const from = i % nodeCount;
        const to = (from + 1 + Math.floor(i / nodeCount)) % nodeCount;
        return { relationId: `rel${i}`, sourceElementId: `el${from}`, targetElementId: `el${to}` };
    });
    return { nodes, edges };
}

/** `Set.prototype.add` calls while `fn` runs: every set the projection builds, element by element (the Set constructor adds through it). */
function setAdds(fn: () => void): number {
    const spy = jest.spyOn(Set.prototype, 'add');
    try {
        fn();
        return spy.mock.calls.length;
    } finally {
        spy.mockRestore();
    }
}

describe('saving a map is linear in its edges', () => {
    it('twice the edges is about twice the work, never four times (the per-edge set of the others was quadratic)', () => {
        const half = rowsToTldraw(mapOf(MAX_MAP_NODES / 2, MAX_MAP_EDGES / 2));
        const full = rowsToTldraw(mapOf(MAX_MAP_NODES, MAX_MAP_EDGES));
        const small = setAdds(() => tldrawToRows(half));
        const large = setAdds(() => tldrawToRows(full));
        expect(large / small).toBeLessThan(2.5);
        // In absolute terms: a few adds per node and edge, not one per pair of edges (2.25 million).
        expect(large).toBeLessThan(10 * (MAX_MAP_NODES + MAX_MAP_EDGES));
    });

    it('a relation drawn twice is still refused DUPLICATE_EDGE (the faster check is the same check)', () => {
        const rows = mapOf(4, 3);
        const graph = rowsToTldraw(rows);
        graph.bindings.push({ ...graph.bindings[0], id: 'binding:copy' });
        expect(() => tldrawToRows(graph)).toThrow(/DUPLICATE_EDGE/);
        expect(tldrawToRows(rowsToTldraw(rows))).toEqual(rows);
    });
});

describe('the layout worker', () => {
    function workerScope() {
        const posted: Array<AutoLayoutReply & { worker: string }> = [];
        const scope = {
            onmessage: null as null | ((event: { data: never }) => void),
            postMessage: (m: AutoLayoutReply & { worker: string }) => posted.push(m),
        };
        installLayoutWorker(scope as never);
        return { scope, posted };
    }

    it('answers a job with the layout the main thread would make, under the job’s id', () => {
        const rows = mapOf(40, 90);
        const nodes = rows.nodes.map((n) => ({ id: n.elementId, position: { x: n.x, y: n.y }, width: n.w, height: n.h }));
        const edges = rows.edges.map((e) => ({ source: e.sourceElementId, target: e.targetElementId }));
        const { scope, posted } = workerScope();
        scope.onmessage!({ data: { id: 7, nodes, edges, direction: 'TB' } as never });
        expect(posted).toEqual([{ id: 7, positions: computeAutoLayout(nodes, edges, 'TB').positions, worker: LAYOUT_WORKER_MARKER }]);
        // A selection: only those nodes, re-centred where they were.
        scope.onmessage!({ data: { id: 8, nodes, edges, direction: 'LR', nodeIds: ['el1', 'el2', 'el3'] } as never });
        expect(posted[1]).toEqual({ id: 8, positions: computeAutoLayout(nodes, edges, 'LR', new Set(['el1', 'el2', 'el3'])).positions, worker: LAYOUT_WORKER_MARKER });
    });

    it('answers a job it cannot lay out with `failed`, never a throw the page cannot see', () => {
        const { scope, posted } = workerScope();
        scope.onmessage!({ data: { id: 9, nodes: null, edges: [], direction: 'TB' } as never });
        expect(posted).toEqual([{ id: 9, failed: true, worker: LAYOUT_WORKER_MARKER }]);
    });

    it('is not installed by importing the module outside a worker', () => {
        // The module was imported above, in Node: nothing took over this global.
        expect((globalThis as { onmessage?: unknown }).onmessage).toBeUndefined();
    });

    it('a reply for another job is not taken for this one: the layout falls back to the main thread', async () => {
        const rows = mapOf(6, 6);
        const nodes = rows.nodes.map((n) => ({ id: n.elementId, position: { x: n.x, y: n.y } }));
        const port = {
            onmessage: null as null | ((e: { data: AutoLayoutReply }) => void),
            onerror: null,
            terminate: jest.fn(),
            postMessage: () => setTimeout(() => port.onmessage?.({ data: { id: -1, positions: { el0: { x: 1e6, y: 1e6 } } } }), 0),
        };
        const result = await layoutOffMainThread({ nodes, edges: [], direction: 'LR' }, async () => port);
        expect(result.thread).toBe('main');
        expect(result.positions).toEqual(computeAutoLayout(nodes, [], 'LR').positions);
        expect(port.terminate).toHaveBeenCalled();
    });
});
