/**
 * A story map's persisted state, as one canonical value (Phase 3.1).
 *
 * The save compares the state it is asked to store with the state stored,
 * and writes nothing — no version, no snapshot — when the two are the same
 * (a save that changes nothing writes none, as a bible save). The snapshot
 * of a save IS this canonical form, so a snapshot can be compared with the
 * live map by string equality, and `parseMapState` reads one back.
 *
 * Canonical means: nodes ordered by element id and edges by relation id,
 * each object's members written in one fixed order, optional members as
 * `null`, never absent. Freeform records are carried as given (they were
 * sanitised on the way in; their member order is the renderer's).
 *
 * Client-safe (no imports but zod).
 */
import { z } from 'zod';

export interface MapNodeRow {
    elementId: string;
    x: number;
    y: number;
    w: number;
    h: number;
    lane: string | null;
}

export interface MapEdgeRow {
    relationId: string;
    sourceElementId: string;
    targetElementId: string;
}

export interface MapState {
    nodes: MapNodeRow[];
    edges: MapEdgeRow[];
    freeform: Record<string, unknown>[];
}

const byKey = <T>(key: (t: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** The state with every member in canonical order and form. */
export function canonicalMapState(state: MapState): MapState {
    return {
        nodes: [...state.nodes]
            .map((n) => ({ elementId: n.elementId, x: n.x, y: n.y, w: n.w, h: n.h, lane: n.lane ?? null }))
            .sort(byKey((n) => n.elementId)),
        edges: [...state.edges]
            .map((e) => ({ relationId: e.relationId, sourceElementId: e.sourceElementId, targetElementId: e.targetElementId }))
            .sort(byKey((e) => e.relationId)),
        freeform: state.freeform,
    };
}

/** The canonical JSON a snapshot stores and a no-op save is detected by. */
export function serialiseMapState(state: MapState): string {
    return JSON.stringify(canonicalMapState(state));
}

const StoredState = z.object({
    nodes: z.array(
        z.object({
            elementId: z.string(),
            x: z.number(),
            y: z.number(),
            w: z.number(),
            h: z.number(),
            lane: z.string().nullable(),
        }),
    ),
    edges: z.array(z.object({ relationId: z.string(), sourceElementId: z.string(), targetElementId: z.string() })),
    freeform: z.array(z.record(z.string(), z.unknown())),
});

/** A stored snapshot read back, or null when it is not one (never a throw: a page shows what it can). */
export function parseMapState(stored: string): MapState | null {
    try {
        const parsed = StoredState.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
