/**
 * The diff the history's Compare shows (Phase 3.1); adapted from
 * inflect-compliance's `canvas-diff.test.ts` (docs/carve-manifest.md).
 */
import { computeCanvasDiff, diffChangeCount } from '@/lib/canvas/canvas-diff';
import type { MapState } from '@/lib/canvas/map-state';

const base: MapState = {
    nodes: [
        { elementId: 'a', x: 0, y: 0, w: 100, h: 50, lane: null },
        { elementId: 'b', x: 10, y: 10, w: 100, h: 50, lane: null },
        { elementId: 'c', x: 20, y: 20, w: 100, h: 50, lane: null },
        { elementId: 'gone', x: 0, y: 0, w: 100, h: 50, lane: null },
    ],
    edges: [
        { relationId: 'r1', sourceElementId: 'a', targetElementId: 'b' },
        { relationId: 'r-gone', sourceElementId: 'a', targetElementId: 'c' },
    ],
    freeform: [{ id: 'shape:n', typeName: 'shape', type: 'note' }],
};

it('classifies added, removed, moved, resized and unchanged nodes and edges, and counts them', () => {
    const next: MapState = {
        nodes: [
            { elementId: 'a', x: 0.2, y: 0, w: 100, h: 50, lane: null }, // under half a unit: unchanged
            { elementId: 'b', x: 40, y: 10, w: 100, h: 50, lane: null }, // moved
            { elementId: 'c', x: 20, y: 20, w: 180, h: 50, lane: 'act-1' }, // resized and laned
            { elementId: 'new', x: 0, y: 0, w: 100, h: 50, lane: null },
        ],
        edges: [
            { relationId: 'r1', sourceElementId: 'a', targetElementId: 'b' },
            { relationId: 'r-new', sourceElementId: 'b', targetElementId: 'c' },
        ],
        freeform: base.freeform,
    };
    const d = computeCanvasDiff(base, next);
    expect(Object.fromEntries(d.nodes)).toEqual({ a: 'unchanged', b: 'moved', c: 'modified', gone: 'removed', new: 'added' });
    expect(Object.fromEntries(d.edges)).toEqual({ r1: 'unchanged', 'r-gone': 'removed', 'r-new': 'added' });
    expect(d.summary).toEqual({ nodesAdded: 1, nodesRemoved: 1, nodesMoved: 1, nodesModified: 1, edgesAdded: 1, edgesRemoved: 1, edgesModified: 0 });
    expect(d.freeformChanged).toBe(false);
    expect(diffChangeCount(d)).toBe(6);
});

it('a state against itself has no changes; a changed freeform layer is one', () => {
    expect(diffChangeCount(computeCanvasDiff(base, base))).toBe(0);
    const d = computeCanvasDiff(base, { ...base, freeform: [] });
    expect(d.freeformChanged).toBe(true);
    expect(diffChangeCount(d)).toBe(1);
});
