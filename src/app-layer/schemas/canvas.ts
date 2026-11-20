/**
 * The story canvas API's request shapes (Phase 3.1). Strict: an unknown
 * member is a 400, never ignored.
 *
 * A save is the map's WHOLE state — every node, every edge and the freeform
 * layer — named against the version it was read at (`expectedVersion`; 0
 * for a map nobody has saved yet). Nodes are keyed by the element they draw
 * and edges by the relation they draw: each appears on a map at most once.
 * An edge also names the two elements it joins, which the server checks
 * against the relation, so a client that drew it the wrong way round is
 * told rather than corrected.
 */
import { z } from 'zod';
import { COORDINATE_BOUND, LANE_KEY, MAX_MAP_EDGES, MAX_MAP_NODES, NODE_MAX_SIZE, NODE_MIN_SIZE } from '@/lib/canvas/limits';

const id = z.string().min(1).max(64);
const coordinate = z.number().finite().min(-COORDINATE_BOUND).max(COORDINATE_BOUND);
const size = z.number().finite().min(NODE_MIN_SIZE).max(NODE_MAX_SIZE);
/** PostgreSQL's integer, which the version column is. */
const version = z.number().int().min(0).max(2_147_483_647);

export const MapNodeInput = z
    .object({
        elementId: id,
        x: coordinate,
        y: coordinate,
        w: size,
        h: size,
        lane: z.string().regex(LANE_KEY).nullable(),
    })
    .strict();
export type MapNodeInput = z.infer<typeof MapNodeInput>;

export const MapEdgeInput = z
    .object({
        relationId: id,
        sourceElementId: id,
        targetElementId: id,
    })
    .strict();
export type MapEdgeInput = z.infer<typeof MapEdgeInput>;

export const MapSaveInput = z
    .object({
        expectedVersion: version,
        nodes: z.array(MapNodeInput).max(MAX_MAP_NODES),
        edges: z.array(MapEdgeInput).max(MAX_MAP_EDGES),
        /** The renderer's own records; checked and sanitised by `sanitiseFreeformForStorage`. */
        freeform: z.array(z.unknown()),
    })
    .strict();
export type MapSaveInput = z.infer<typeof MapSaveInput>;

export const MapRestoreInput = z.object({ expectedVersion: version }).strict();
