/**
 * `rows → tldraw → rows` is the identity (Phase 3.1).
 *
 * Ported from inflect-compliance's `tests/unit/processes/serializer-round-trip.test.ts`
 * (docs/carve-manifest.md), on the story map's rows: nodes keyed by element,
 * edges by relation.
 *
 * If a load/save cycle with no edit did not reproduce the row set, every
 * autosave would write a spurious version and every diff would be noise. So
 * the assertions are `toEqual` on the whole row set, and the fixtures are
 * awkward on purpose: a lane present and absent, negative and fractional
 * coordinates, a resized node, an edge in each direction between the same two
 * elements, and a sticky note that must never become a row.
 */
import {
    EdgeEndpointError,
    PERSISTED_EDGE_PROPS,
    PERSISTED_NODE_PROPS,
    partitionCanvas,
    rowsToTldraw,
    tldrawToRows,
    type CanvasRecord,
    type GraphRows,
    type MapDisplay,
} from '@/components/canvas/tldraw/serializer';
import { elementIdFromShapeId, shapeIdForElement } from '@/components/canvas/tldraw/story-node-shape';
import { STORY_EDGE_SHAPE_TYPE } from '@/components/canvas/tldraw/story-edge-shape';

const ROWS: GraphRows = {
    nodes: [
        { elementId: 'el-ada', x: 0, y: 0, w: 220, h: 88, lane: null },
        // Negative and fractional — an integer round trip would hide a coercion.
        { elementId: 'el-bea', x: -412.5, y: 96.25, w: 300.5, h: 120, lane: 'act-2' },
        { elementId: 'el-cyd', x: 500, y: 0, w: 220, h: 88, lane: 'lane:cyd' },
    ],
    edges: [
        { relationId: 'rel-1', sourceElementId: 'el-ada', targetElementId: 'el-bea' },
        // The other direction between the same pair: a different relation, a different edge.
        { relationId: 'rel-2', sourceElementId: 'el-bea', targetElementId: 'el-ada' },
        { relationId: 'rel-3', sourceElementId: 'el-cyd', targetElementId: 'el-ada' },
    ],
};

const DISPLAY: MapDisplay = {
    nodes: new Map([
        ['el-ada', { name: 'Ada', kindLabel: 'Character', badgeLabel: '40%', badgeTone: 'partial' }],
        ['el-bea', { name: 'Bea', kindLabel: 'Character', badgeLabel: 'Not assessed', badgeTone: 'none' }],
    ]),
    edgeLabels: new Map([['rel-1', 'mentors']]),
};

const STICKY: CanvasRecord = { id: 'shape:sticky-1', type: 'note', typeName: 'shape', x: 10, y: 10, props: { text: 'STICKY-NOT-A-ROW' } };

describe('rows → tldraw → rows is the identity', () => {
    it('reproduces the row set EXACTLY, whole-object', () => {
        expect(tldrawToRows(rowsToTldraw(ROWS, DISPLAY))).toEqual(ROWS);
    });

    it('stays exact over repeated cycles — drift compounds or it does not exist', () => {
        let g = rowsToTldraw(ROWS, DISPLAY);
        for (let i = 0; i < 5; i++) g = rowsToTldraw(tldrawToRows(g), DISPLAY, g.freeform);
        expect(tldrawToRows(g)).toEqual(ROWS);
    });

    it('produces DETERMINISTIC ids derived from the element and relation ids', () => {
        const a = rowsToTldraw(ROWS);
        const b = rowsToTldraw(ROWS);
        expect(a.shapes.map((s) => s.id)).toEqual(b.shapes.map((s) => s.id));
        expect(a.bindings.map((x) => x.id)).toEqual(['binding:rel-1', 'binding:rel-2', 'binding:rel-3']);
        expect(a.shapes.map((s) => s.id)).toEqual(ROWS.nodes.map((n) => shapeIdForElement(n.elementId)));
        expect(a.shapes.map((s) => elementIdFromShapeId(s.id))).toEqual(ROWS.nodes.map((n) => n.elementId));
    });

    it('what a node SHOWS comes in beside the rows and never goes back out', () => {
        const g = rowsToTldraw(ROWS, DISPLAY);
        expect(g.shapes[0].props).toMatchObject({ name: 'Ada', kindLabel: 'Character', badgeLabel: '40%', badgeTone: 'partial' });
        // A node the display does not know still renders, with empty words.
        expect(g.shapes[2].props).toMatchObject({ name: '', badgeTone: 'none' });
        g.shapes[0].props.name = 'Renamed on the canvas';
        expect(tldrawToRows(g)).toEqual(ROWS);
        expect(JSON.stringify(tldrawToRows(g))).not.toContain('Renamed');
    });
});

describe('undefined normalises to null on the way in', () => {
    it('an omitted lane round-trips as null, and the shape carries null (the validator refuses undefined)', () => {
        const sparse = { nodes: [{ elementId: 'x', x: 1, y: 2, w: 50, h: 60 } as GraphRows['nodes'][number]], edges: [] };
        const g = rowsToTldraw(sparse);
        expect(g.shapes[0].props.lane).toBeNull();
        expect('lane' in g.shapes[0].props).toBe(true);
        expect(tldrawToRows(g).nodes[0]).toEqual({ elementId: 'x', x: 1, y: 2, w: 50, h: 60, lane: null });
    });
});

describe('geometry comes from the shape, never from props', () => {
    it('a moved node round-trips its NEW position, a resized one its new size', () => {
        const g = rowsToTldraw(ROWS);
        g.shapes[0].x = 1234.5;
        g.shapes[0].y = -6.75;
        g.shapes[1].props.w = 444;
        const out = tldrawToRows(g);
        expect(out.nodes[0]).toMatchObject({ x: 1234.5, y: -6.75 });
        expect(out.nodes[1].w).toBe(444);
    });
});

describe('freeform never becomes a row', () => {
    it('a sticky note on the canvas produces NO node, and IS carried as freeform', () => {
        const g = rowsToTldraw(ROWS, DISPLAY, [STICKY as never]);
        const out = tldrawToRows(g);
        expect(out.nodes).toHaveLength(ROWS.nodes.length);
        expect(JSON.stringify(out)).not.toContain('STICKY-NOT-A-ROW');
        expect(JSON.stringify(g.freeform)).toContain('STICKY-NOT-A-ROW');
    });

    it('a non-node shape smuggled into `shapes` is ignored, not turned into a row', () => {
        const g = rowsToTldraw(ROWS);
        const polluted = { ...g, shapes: [...g.shapes, STICKY as unknown as (typeof g.shapes)[number]] };
        expect(tldrawToRows(polluted).nodes).toHaveLength(ROWS.nodes.length);
    });

    it('partitionCanvas sorts a mixed canvas four ways, a derived edge line into `derived`', () => {
        const g = rowsToTldraw(ROWS);
        const LINE = { id: 'shape:edge-rel-1', type: STORY_EDGE_SHAPE_TYPE, typeName: 'shape', x: 0, y: 0, props: { relationId: 'rel-1', label: '', dx: 1, dy: 2 } } as CanvasRecord;
        const p = partitionCanvas([...g.shapes, ...g.bindings, STICKY, LINE]);
        expect(p.shapes).toHaveLength(ROWS.nodes.length);
        expect(p.bindings).toHaveLength(ROWS.edges.length);
        // A line falling through to `freeform` would be saved, then re-derived AND restored: doubling every save.
        expect(p.derived).toEqual([LINE]);
        expect(p.freeform).toEqual([STICKY]);
    });
});

describe('an edge the map cannot hold is refused, not written', () => {
    it('an end re-pointed at a shape that is no node: UNKNOWN_NODE (and the relation no longer matches)', () => {
        const g = rowsToTldraw(ROWS);
        g.bindings[0].toId = 'shape:does-not-exist';
        expect(() => tldrawToRows(g)).toThrow(EdgeEndpointError);
        try {
            tldrawToRows(g);
        } catch (e) {
            expect((e as EdgeEndpointError).refusals.map((r) => r.code)).toEqual(['UNKNOWN_NODE', 'RELATION_MISMATCH']);
        }
    });

    it('an end re-attached to another node: RELATION_MISMATCH (an edge draws its relation, nothing else)', () => {
        const g = rowsToTldraw(ROWS);
        g.bindings[0].toId = shapeIdForElement('el-cyd');
        try {
            tldrawToRows(g);
            throw new Error('expected a refusal');
        } catch (e) {
            expect((e as EdgeEndpointError).refusals.map((r) => r.code)).toEqual(['RELATION_MISMATCH']);
        }
    });

    it('one relation drawn twice: DUPLICATE_EDGE', () => {
        const g = rowsToTldraw(ROWS);
        g.bindings.push({ ...g.bindings[0], id: 'binding:copy' });
        expect(() => tldrawToRows(g)).toThrow(/DUPLICATE_EDGE/);
    });

    it('a valid graph throws nothing — the control for the three above', () => {
        expect(() => tldrawToRows(rowsToTldraw(ROWS))).not.toThrow();
    });
});

describe("a node's element resolves through its props, not its id", () => {
    it('a pasted node with a fresh id still names its element, and its edges follow it', () => {
        const g = rowsToTldraw(ROWS);
        const drawnId = 'shape:V1StGXR8Z5jdHi6BMyT';
        g.shapes[1].id = drawnId;
        g.bindings[0].toId = drawnId;
        g.bindings[1].fromId = drawnId;
        const out = tldrawToRows(g);
        expect(out.nodes[1].elementId).toBe('el-bea');
        expect(out.edges[0].targetElementId).toBe('el-bea');
        expect(out.edges[1].sourceElementId).toBe('el-bea');
    });

    it('a binding left pointing at a REPLACED id is refused, never saved with an empty end', () => {
        const g = rowsToTldraw(ROWS);
        g.shapes[1].id = 'shape:renamed-and-not-rewired';
        expect(() => tldrawToRows(g)).toThrow(EdgeEndpointError);
    });
});

describe('the persisted props are exactly what the projection reads', () => {
    // Derived from behaviour, not the list: a distinct value in every prop of a
    // node and a binding, then which of them reach the rows.
    it('nodes: elementId, w, h and lane (with x/y on the shape); edges: all three binding props', () => {
        const g = rowsToTldraw({ nodes: [{ elementId: 'a', x: 1, y: 2, w: 30, h: 40, lane: 'l' }, { elementId: 'b', x: 0, y: 0, w: 30, h: 40, lane: null }], edges: [{ relationId: 'r', sourceElementId: 'a', targetElementId: 'b' }] });
        const base = JSON.stringify(tldrawToRows(g));
        const readNodeProps = Object.keys(g.shapes[0].props).filter((k) => {
            const copy = structuredClone(g);
            const props = copy.shapes[0].props as Record<string, unknown>;
            props[k] = typeof props[k] === 'number' ? (props[k] as number) + 7 : `${String(props[k])}-changed`;
            try {
                return JSON.stringify(tldrawToRows(copy)) !== base;
            } catch {
                return true;
            }
        });
        expect(readNodeProps.sort()).toEqual([...PERSISTED_NODE_PROPS].sort());
        const readEdgeProps = Object.keys(g.bindings[0].props).filter((k) => {
            const copy = structuredClone(g);
            (copy.bindings[0].props as Record<string, unknown>)[k] = 'changed';
            try {
                return JSON.stringify(tldrawToRows(copy)) !== base;
            } catch {
                return true;
            }
        });
        expect(readEdgeProps.sort()).toEqual([...PERSISTED_EDGE_PROPS].sort());
    });
});
