/**
 * Seeded random story maps for the round-trip property tests (Phase 3.H).
 *
 * mulberry32: a few lines, no dependency, the same numbers on every machine,
 * so a failing case is named by its seed and reproduces. The graphs reach
 * every shape a map's rows can take: nodes with and without a lane, negative,
 * fractional and bound-sized coordinates and sizes, several relations
 * between one pair, both directions, and freeform notes beside them.
 */
import type { FreeformRecord, GraphRows } from '@/components/canvas/tldraw/serializer';
import type { LaneNodeInput } from '@/lib/canvas/lanes';
import { COORDINATE_BOUND, NODE_MAX_SIZE, NODE_MIN_SIZE } from '@/lib/canvas/limits';

export type Rng = () => number;

export function rng(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const int = (next: Rng, lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
const pick = <T>(next: Rng, items: readonly T[]): T => items[Math.floor(next() * items.length)];
const id = (next: Rng, prefix: string) => `${prefix}${Math.floor(next() * 36 ** 8).toString(36).padStart(8, '0')}`;

/** A coordinate: mostly ordinary, sometimes fractional and negative, sometimes at the bound. */
function coordinate(next: Rng): number {
    const r = next();
    if (r < 0.05) return pick(next, [COORDINATE_BOUND, -COORDINATE_BOUND]);
    if (r < 0.4) return -int(next, 0, 5000) - pick(next, [0.25, 0.5, 0.125]);
    return int(next, -2000, 8000) + (next() < 0.3 ? pick(next, [0.5, 0.75]) : 0);
}

function size(next: Rng): number {
    const r = next();
    if (r < 0.05) return NODE_MIN_SIZE;
    if (r < 0.1) return NODE_MAX_SIZE;
    return int(next, 40, 600) + (next() < 0.2 ? 0.5 : 0);
}

export interface RandomGraphOptions {
    maxNodes?: number;
    maxEdgesPerNode?: number;
    /** Freeform notes beside the rows. */
    maxNotes?: number;
}

/** A random map: rows that the save accepts (distinct elements, relations between two distinct nodes, each drawn once) and notes. */
export function randomGraph(next: Rng, options: RandomGraphOptions = {}): { rows: GraphRows; freeform: FreeformRecord[] } {
    const { maxNodes = 30, maxEdgesPerNode = 3, maxNotes = 4 } = options;
    const n = int(next, 0, maxNodes);
    const elementIds = new Set<string>();
    while (elementIds.size < n) elementIds.add(id(next, 'el'));
    const nodes = [...elementIds].map((elementId) => ({
        elementId,
        x: coordinate(next),
        y: coordinate(next),
        w: size(next),
        h: size(next),
        lane: next() < 0.4 ? pick(next, ['opening', 'act-2', 'lane:x', 'placed', 'no-act']) : null,
    }));
    const edges: GraphRows['edges'] = [];
    const relationIds = new Set<string>();
    if (nodes.length >= 2) {
        const m = int(next, 0, nodes.length * maxEdgesPerNode);
        for (let i = 0; i < m; i++) {
            const a = pick(next, nodes).elementId;
            let b = pick(next, nodes).elementId;
            if (a === b) b = nodes[(nodes.findIndex((x) => x.elementId === a) + 1) % nodes.length].elementId;
            let relationId = id(next, 'rel');
            while (relationIds.has(relationId)) relationId = id(next, 'rel');
            relationIds.add(relationId);
            edges.push({ relationId, sourceElementId: a, targetElementId: b });
            // Sometimes the other direction, as another relation between the same pair.
            if (next() < 0.15) {
                let back = id(next, 'rel');
                while (relationIds.has(back)) back = id(next, 'rel');
                relationIds.add(back);
                edges.push({ relationId: back, sourceElementId: b, targetElementId: a });
            }
        }
    }
    const freeform: FreeformRecord[] = Array.from({ length: int(next, 0, maxNotes) }, (_, i) => ({
        id: `shape:note-${i}-${id(next, '')}`,
        typeName: 'shape',
        type: 'note',
        x: coordinate(next),
        y: coordinate(next),
        props: { text: `note ${i} <b ${int(next, 0, 99)}` },
    }));
    return { rows: { nodes, edges }, freeform };
}

/** Random cards for a derived map: some placed (distinct ranks), some not, some in an act, some in none. */
export function randomLaneNodes(next: Rng, acts: readonly string[], max = 40): LaneNodeInput[] {
    const n = int(next, 1, max);
    const ranks = new Set<string>();
    return Array.from({ length: n }, (_, i) => {
        let orderRank: string | null = null;
        if (next() < 0.7) {
            do orderRank = int(next, 1, 35 * 35).toString(36).replace(/0+$/, '') || 'z';
            while (ranks.has(orderRank));
            ranks.add(orderRank);
        }
        return {
            elementId: `el${i.toString().padStart(3, '0')}${id(next, '')}`,
            name: `Card ${int(next, 0, 999)}`,
            orderRank,
            act: next() < 0.75 ? pick(next, acts) : null,
        };
    });
}
