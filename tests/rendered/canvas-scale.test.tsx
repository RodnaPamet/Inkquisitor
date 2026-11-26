/**
 * The canvas at its bounds, through a LIVE tldraw store (Phase 3.H, items 1
 * and 2).
 *
 *   - The round trip as a property: random graphs seeded into an editor and
 *     serialised back are the rows they came from (the pure half is
 *     `tests/unit/canvas/round-trip-property.test.ts`).
 *   - 500 nodes and 1,500 edges (`MAX_MAP_NODES`, `MAX_MAP_EDGES`) load,
 *     round-trip, and deleting every edge does no work per edge over the
 *     whole store (it used to scan every record for each line deleted).
 *   - Arrange runs OFF THE MAIN THREAD: the layout is posted to a worker, the
 *     main thread never runs dagre, the canvas takes edits while the worker
 *     works, and a node removed meanwhile is not written back.
 *
 * jsdom proves wiring and counted work, never frames (`tests/helpers/tldraw-jsdom.ts`).
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

jest.mock('@/lib/canvas/canvas-auto-layout', () => {
    const actual = jest.requireActual('@/lib/canvas/canvas-auto-layout');
    return { ...actual, computeAutoLayout: jest.fn(actual.computeAutoLayout) };
});

import { act, render } from '@testing-library/react';
import type { Editor, TLShapeId } from 'tldraw';

import { StoryMapCanvas } from '@/components/canvas/StoryMapCanvas';
import { runAutoLayout } from '@/components/canvas/tldraw/auto-layout-host';
import { serializeEditorCanvas } from '@/components/canvas/tldraw/editor-canvas';
import type { GraphRows, MapDisplay } from '@/components/canvas/tldraw/serializer';
import { STORY_EDGE_SHAPE_TYPE } from '@/components/canvas/tldraw/story-edge-shape';
import { shapeIdForElement } from '@/components/canvas/tldraw/story-node-shape';
import { computeAutoLayout } from '@/lib/canvas/canvas-auto-layout';
import type { AutoLayoutJob, AutoLayoutReply, LayoutWorkerPort } from '@/lib/canvas/auto-layout-off-thread';
import { MAX_MAP_EDGES, MAX_MAP_NODES } from '@/lib/canvas/limits';
import { canonicalMapState } from '@/lib/canvas/map-state';
import { randomGraph, rng } from '../helpers/random-graph';

jest.setTimeout(120_000);

const DISPLAY: MapDisplay = { nodes: new Map(), edgeLabels: new Map() };
const canonical = (rows: GraphRows) => canonicalMapState({ ...rows, freeform: [] });

async function mount(rows: GraphRows, freeform: unknown[] = []): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 1000, height: 700 }}>
                <StoryMapCanvas rows={rows} display={DISPLAY} freeform={freeform as never} relations={() => []} onEditorReady={(e) => (editor = e)} />
            </div>,
        );
    });
    if (!editor) throw new Error('the canvas did not mount');
    return editor;
}

/** A full map: 500 nodes and 1,500 edges, each relation its own pair's. */
function fullMap(): GraphRows {
    const nodes = Array.from({ length: MAX_MAP_NODES }, (_, i) => ({ elementId: `el${String(i).padStart(4, '0')}`, x: (i % 25) * 260, y: Math.floor(i / 25) * 140, w: 220, h: 88, lane: null }));
    const edges = Array.from({ length: MAX_MAP_EDGES }, (_, i) => {
        const from = i % MAX_MAP_NODES;
        const to = (from + 1 + Math.floor(i / MAX_MAP_NODES)) % MAX_MAP_NODES;
        return { relationId: `rel${String(i).padStart(4, '0')}`, sourceElementId: nodes[from].elementId, targetElementId: nodes[to].elementId };
    });
    return { nodes, edges };
}

describe('the round trip through a live store, over random graphs', () => {
    it.each([0x51, 0x52, 0x53, 0x54, 0x55, 0x56])('seed %i: what is saved is exactly what was loaded', async (seed) => {
        const { rows, freeform } = randomGraph(rng(seed), { maxNodes: 40 });
        const notes = freeform.map((r) => ({ ...r, rotation: 0, isLocked: false, opacity: 1, index: 'a9', parentId: 'page:page', meta: {}, props: {} }));
        const editor = await mount(rows, notes);
        const canvas = serializeEditorCanvas(editor);
        expect(canonical(canvas.rows)).toEqual(canonical(rows));
        expect(canvas.freeform.map((r) => r.id).sort()).toEqual(notes.map((r) => r.id).sort());
    });
});

describe('a full map: 500 nodes and 1,500 edges', () => {
    it('loads and round-trips exactly', async () => {
        const rows = fullMap();
        const editor = await mount(rows);
        expect(canonical(serializeEditorCanvas(editor).rows)).toEqual(canonical(rows));
    });

    it('deleting every edge reads no whole store per edge: the bindings are found by id', async () => {
        const rows = fullMap();
        const editor = await mount(rows);
        const lines = editor.getCurrentPageShapes().filter((s) => s.type === STORY_EDGE_SHAPE_TYPE);
        expect(lines).toHaveLength(MAX_MAP_EDGES);
        const scans = jest.spyOn(editor.store, 'allRecords');
        await act(async () => {
            editor.deleteShapes(lines.map((s) => s.id));
        });
        // A constant, not one per line (1,500 before 3.H).
        expect(scans.mock.calls.length).toBeLessThan(10);
        scans.mockRestore();
        const saved = serializeEditorCanvas(editor).rows;
        expect(saved.edges).toEqual([]);
        expect(saved.nodes).toHaveLength(MAX_MAP_NODES);
    });
});

describe('arrange runs off the main thread', () => {
    const layoutOnMain = computeAutoLayout as jest.MockedFunction<typeof computeAutoLayout>;
    /** Every laid-out node moved by a fixed offset: linear, and different from where it stood. */
    function shiftedLayout(job: AutoLayoutJob): Record<string, { x: number; y: number }> {
        const only = job.nodeIds ? new Set(job.nodeIds) : null;
        const positions: Record<string, { x: number; y: number }> = {};
        for (const node of job.nodes) {
            if (only && !only.has(node.id)) continue;
            positions[node.id] = { x: node.position.x + 137, y: node.position.y + 91 };
        }
        return positions;
    }

    /**
     * A stand-in for the browser's worker: it answers a macrotask later, as a
     * real one would. What it answers is a cheap, deterministic layout (every
     * node shifted), not dagre: these tests are about WHERE the layout runs and
     * how its answer is applied, and dagre over 500 nodes and 1,500 edges inside
     * jsdom ran past Jest's 120 s on a loaded CI runner (PR #59) — a verdict a
     * wall clock decided. Dagre's own output is tested in `canvas-auto-layout`.
     */
    function fakeWorker(posted: AutoLayoutJob[]): LayoutWorkerPort {
        const port: LayoutWorkerPort = {
            onmessage: null,
            onerror: null,
            terminate: jest.fn(),
            postMessage: (job) => {
                posted.push(job);
                setTimeout(() => {
                    const positions = shiftedLayout(job);
                    port.onmessage?.({ data: { id: job.id, positions } satisfies AutoLayoutReply });
                }, 20);
            },
        };
        return port;
    }

    beforeEach(() => layoutOnMain.mockClear());

    it('posts the graph to the worker, never runs dagre on the main thread, and applies the answer as one undo step', async () => {
        const rows = fullMap();
        const editor = await mount(rows);
        const before = canonical(serializeEditorCanvas(editor).rows).nodes;
        const posted: AutoLayoutJob[] = [];
        let worker: LayoutWorkerPort | null = null;
        let result: Awaited<ReturnType<typeof runAutoLayout>> | null = null;
        await act(async () => {
            result = await runAutoLayout(editor, 'LR', 'all', { createWorker: async () => (worker = fakeWorker(posted)) });
        });
        expect(result).toEqual({ moved: MAX_MAP_NODES, thread: 'worker' });
        expect(layoutOnMain).not.toHaveBeenCalled();
        expect(posted).toHaveLength(1);
        expect(posted[0].nodes).toHaveLength(MAX_MAP_NODES);
        expect(posted[0].edges).toHaveLength(MAX_MAP_EDGES);
        // Ids, numbers and a direction: nothing a node shows travels.
        expect(Object.keys(posted[0].nodes[0]).sort()).toEqual(['height', 'id', 'position', 'width']);
        expect(worker!.terminate).toHaveBeenCalledTimes(1);
        expect(canonical(serializeEditorCanvas(editor).rows).nodes).not.toEqual(before);
        await act(async () => {
            editor.undo();
        });
        expect(canonical(serializeEditorCanvas(editor).rows).nodes).toEqual(before);
    });

    it('the canvas takes edits while the worker works, and a node removed meanwhile is not written back', async () => {
        const rows = fullMap();
        const editor = await mount(rows);
        const posted: AutoLayoutJob[] = [];
        let pending: Promise<unknown> | null = null;
        await act(async () => {
            pending = runAutoLayout(editor, 'TB', 'all', { createWorker: async () => fakeWorker(posted) });
            // The layout is out; the main thread is free: the author deletes a node.
            await new Promise((r) => setTimeout(r, 0));
            expect(posted).toHaveLength(1);
            editor.deleteShapes([shapeIdForElement('el0007') as TLShapeId]);
            await pending;
        });
        expect(editor.getShape(shapeIdForElement('el0007') as TLShapeId)).toBeUndefined();
        expect(serializeEditorCanvas(editor).rows.nodes).toHaveLength(MAX_MAP_NODES - 1);
        expect(layoutOnMain).not.toHaveBeenCalled();
    });

    it('with no worker, or a worker that fails, the layout still runs (on the main thread)', async () => {
        const editor = await mount(randomGraph(rng(0x77), { maxNodes: 12 }).rows);
        let none: Awaited<ReturnType<typeof runAutoLayout>> | null = null;
        await act(async () => {
            none = await runAutoLayout(editor, 'LR', 'all', { createWorker: async () => null });
        });
        expect(none!.thread).toBe('main');
        const failing: LayoutWorkerPort = {
            onmessage: null,
            onerror: null,
            terminate: jest.fn(),
            postMessage: () => setTimeout(() => failing.onerror?.(new Error('worker died')), 5),
        };
        let failed: Awaited<ReturnType<typeof runAutoLayout>> | null = null;
        await act(async () => {
            failed = await runAutoLayout(editor, 'TB', 'all', { createWorker: async () => failing });
        });
        expect(failed!.thread).toBe('main');
        expect(failing.terminate).toHaveBeenCalled();
        expect(layoutOnMain).toHaveBeenCalledTimes(2);
    });
});
