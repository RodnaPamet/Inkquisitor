/**
 * The story canvas's bounds (Phase 3.1), shared by the save schema, the
 * server's checks and the editor that warns before them. Client-safe.
 *
 * Exported rather than written into each `.max()`: a client that copies a
 * limit drifts permissive, and the author meets the ceiling as a refusal
 * after the work is done.
 */

/** Nodes a map holds at most (3.H holds 500 nodes interactive). */
export const MAX_MAP_NODES = 500;
/** Edges a map holds at most (3.H: 1,500). */
export const MAX_MAP_EDGES = 1500;

/**
 * The freeform layer (sticky notes, drawings, loose text), as serialised
 * JSON. It is copied whole into a snapshot on every save, so its size is
 * write amplification on an autosave debounce, not one big row; dense
 * freehand needs room, hence well above a single record's size.
 */
export const FREEFORM_MAX_BYTES = 512 * 1024;
/** Records the freeform layer holds at most. */
export const FREEFORM_MAX_RECORDS = 2000;
/** How deep a freeform record may nest (a rich-text document is a few levels). */
export const FREEFORM_MAX_DEPTH = 24;

/** Page-unit bounds a node's position and size keep (the migration's CHECK repeats them). */
export const COORDINATE_BOUND = 10_000_000;
export const NODE_MIN_SIZE = 8;
export const NODE_MAX_SIZE = 100_000;

/** A freshly added node's size. */
export const NODE_DEFAULT_W = 220;
export const NODE_DEFAULT_H = 88;

/** A lane key: an opaque key, never text (the migration's CHECK repeats it). */
export const LANE_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Snapshots one page of the history holds, newest first (3.H). The history is
 * read a page at a time (`before`, a version): every version stays reachable
 * however many saves a map has, and no read grows with them.
 */
export const SNAPSHOT_PAGE_SIZE = 50;
