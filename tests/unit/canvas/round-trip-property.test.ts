/**
 * The round trip, as a property over random graphs (Phase 3.H, item 1).
 *
 * `serializer-round-trip.test.ts` holds the contract on hand-made fixtures;
 * this holds it on graphs nobody chose. A seeded generator (mulberry32, so
 * every run draws the same graphs and a failure names its seed; no
 * dependency) makes maps of every shape the rows can take — nodes with and
 * without lanes, negative and fractional coordinates, sizes at the bounds,
 * several relations between one pair and both directions, freeform notes
 * beside them — and each must come back IDENTICAL:
 *
 *   rows → tldraw → rows                      (the serializer's contract)
 *   state → canonical JSON → state            (the snapshot and the no-op save)
 *   the derived maps' layout, for each kind    (deriving from a derived map moves nothing)
 *
 * The live tldraw store's half is `tests/rendered/canvas-round-trip-property.test.tsx`.
 */
import { rowsToTldraw, tldrawToRows, type GraphRows, type MapDisplay } from '@/components/canvas/tldraw/serializer';
import { COORDINATE_BOUND, NODE_MAX_SIZE, NODE_MIN_SIZE } from '@/lib/canvas/limits';
import { deriveLaneLayout, participantsByEvent, NO_ACT_LANE, type LaneNodeInput } from '@/lib/canvas/lanes';
import { STORY_MAP_KINDS, mapLayoutMode, type StoryMapKindValue } from '@/lib/canvas/map-kinds';
import { canonicalMapState, parseMapState, serialiseMapState, type MapState } from '@/lib/canvas/map-state';
import { randomGraph, randomLaneNodes, rng, type Rng } from '../../helpers/random-graph';

const SEEDS = Array.from({ length: 60 }, (_, i) => 0x3b00 + i);

function displayFor(rows: GraphRows, next: Rng): MapDisplay {
    return {
        nodes: new Map(rows.nodes.map((n) => [n.elementId, { name: `name ${Math.floor(next() * 1e6)}`, kindLabel: 'Character', badgeLabel: '50%', badgeTone: 'partial' as const }])),
        edgeLabels: new Map(rows.edges.map((e) => [e.relationId, `label ${Math.floor(next() * 1e6)}`])),
    };
}

describe.each(SEEDS)('seed %i', (seed) => {
    const next = rng(seed);
    const { rows, freeform } = randomGraph(next);

    it('rows → tldraw → rows is the identity, and stays so over five cycles', () => {
        const display = displayFor(rows, next);
        const graph = rowsToTldraw(rows, display, freeform);
        expect(tldrawToRows(graph)).toEqual(rows);
        let g = graph;
        for (let i = 0; i < 5; i++) g = rowsToTldraw(tldrawToRows(g), display, g.freeform);
        expect(tldrawToRows(g)).toEqual(rows);
        // The freeform layer rides beside the rows untouched, and none of it becomes a row.
        expect(g.freeform).toEqual(freeform);
    });

    it('the canonical state reads back exactly, and canonicalising is idempotent', () => {
        const state: MapState = { nodes: rows.nodes, edges: rows.edges, freeform };
        const json = serialiseMapState(state);
        expect(parseMapState(json)).toEqual(canonicalMapState(state));
        expect(serialiseMapState(parseMapState(json)!)).toBe(json);
        // Order does not matter: the same map in another order is the same snapshot.
        expect(serialiseMapState({ ...state, nodes: [...state.nodes].reverse(), edges: [...state.edges].reverse() })).toBe(json);
    });
});

describe.each(SEEDS.slice(0, 30))('derived layouts, seed %i', (seed) => {
    const next = rng(seed);
    const acts = [
        { value: 'opening', label: 'Opening' },
        { value: 'escalation', label: 'Escalation' },
        { value: 'crisis', label: 'Crisis' },
    ];

    it.each(STORY_MAP_KINDS.filter((k) => mapLayoutMode(k) === 'derived') as StoryMapKindValue[])('%s: derived rows round-trip, and deriving again moves nothing', (kind) => {
        const nodes: LaneNodeInput[] = randomLaneNodes(next, acts.map((a) => a.value));
        const links = nodes.flatMap((n, i) => (i % 3 === 0 ? [{ eventId: n.elementId, characterId: `ch-${i % 5}`, characterName: `Character ${i % 5}` }] : []));
        const options = { acts, participants: participantsByEvent(links) };
        const layout = deriveLaneLayout(kind, nodes, options)!;
        expect(layout).not.toBeNull();
        // The rows a save stores on a derived map: each node where the bible puts it.
        const rows: GraphRows = {
            nodes: nodes.map((n) => {
                const at = layout.positions.get(n.elementId)!;
                return { elementId: n.elementId, x: at.x, y: at.y, w: at.w, h: at.h, lane: at.lane };
            }),
            edges: [],
        };
        expect(tldrawToRows(rowsToTldraw(rows))).toEqual(rows);
        // A lane is a key, never text.
        for (const n of rows.nodes) expect(n.lane).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
        // Every node is placed, once, and no two cards share a place.
        expect(layout.positions.size).toBe(nodes.length);
        const places = new Set(rows.nodes.map((n) => `${n.x},${n.y}`));
        expect(places.size).toBe(nodes.length);
        // Deriving again, in another order, gives the same places: the layout is the bible's, not the input order's.
        const again = deriveLaneLayout(kind, [...nodes].reverse(), options)!;
        for (const n of nodes) expect(again.positions.get(n.elementId)).toEqual(layout.positions.get(n.elementId));
        if (kind === 'PLOT') {
            for (const n of nodes) expect(layout.positions.get(n.elementId)!.lane).toBe(n.act ?? NO_ACT_LANE);
        }
    });
});

it('the generator draws what the contract is about (a check over nothing proves nothing)', () => {
    const drawn = SEEDS.map((s) => randomGraph(rng(s)));
    expect(drawn.some((g) => g.rows.nodes.some((n) => n.lane === null))).toBe(true);
    expect(drawn.some((g) => g.rows.nodes.some((n) => n.lane !== null))).toBe(true);
    expect(drawn.some((g) => g.rows.nodes.some((n) => n.x < 0 && !Number.isInteger(n.x)))).toBe(true);
    expect(drawn.some((g) => g.rows.nodes.some((n) => n.w === NODE_MIN_SIZE || n.w === NODE_MAX_SIZE))).toBe(true);
    expect(drawn.some((g) => g.rows.nodes.some((n) => Math.abs(n.x) === COORDINATE_BOUND))).toBe(true);
    expect(drawn.some((g) => g.rows.edges.some((e) => g.rows.edges.some((f) => f.relationId !== e.relationId && f.sourceElementId === e.targetElementId && f.targetElementId === e.sourceElementId)))).toBe(true);
    expect(drawn.some((g) => g.freeform.length > 0)).toBe(true);
    expect(drawn.reduce((n, g) => n + g.rows.edges.length, 0)).toBeGreaterThan(500);
});
