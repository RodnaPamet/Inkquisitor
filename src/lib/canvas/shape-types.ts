/**
 * The record types the story canvas owns (Phase 3.1). Plain strings, with no
 * tldraw import, so the server's freeform check can refuse them without
 * pulling the renderer into a server bundle.
 *
 *   story-node       a BibleElement drawn on the map (a shape, persisted as a MapNode)
 *   story-edge       a BibleRelation drawn on the map (a binding, persisted as a MapEdge)
 *   story-edge-line  the drawn half of an edge, derived on every load and never persisted
 *
 * Carved from inflect-compliance's process-map types (`process-node`,
 * `process-edge`, `process-edge-line`; docs/carve-manifest.md).
 */
export const STORY_NODE_SHAPE_TYPE = 'story-node' as const;
export const STORY_EDGE_BINDING_TYPE = 'story-edge' as const;
export const STORY_EDGE_SHAPE_TYPE = 'story-edge-line' as const;

/** Types that are rows or derived from rows, and so never belong in the freeform layer. */
export const STRUCTURED_RECORD_TYPES: ReadonlySet<string> = new Set([STORY_NODE_SHAPE_TYPE, STORY_EDGE_BINDING_TYPE, STORY_EDGE_SHAPE_TYPE]);
