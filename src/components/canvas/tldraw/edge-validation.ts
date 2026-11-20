/**
 * Whether an edge may be drawn — decided at DRAW time, and again at save.
 *
 * Carved from inflect-compliance's `edge-validation.ts`
 * (docs/carve-manifest.md). The server refuses the same things
 * (`src/app-layer/usecases/story-maps.ts`); this copy protects the work done
 * between drawing an edge and the autosave, so the author learns at once.
 * Pure: no tldraw import, so it is tested without an editor.
 *
 * A story edge draws ONE BibleRelation, so the refusals are about the
 * relation, not about node kinds (inflect's annotation and group nodes have
 * no counterpart here):
 *
 *   UNKNOWN_NODE       an end names an element that is not on the map
 *   SELF_LOOP          both ends are the same element
 *   DUPLICATE_EDGE     that relation is already drawn on the map
 *   RELATION_MISMATCH  the ends are not the relation's own two elements
 *
 * Every applicable refusal is returned, not the first, and a refusal is a
 * value rather than a throw: this runs while a pointer is moving.
 */

export type EdgeRefusal =
    | { code: 'UNKNOWN_NODE'; elementId: string }
    | { code: 'SELF_LOOP'; elementId: string }
    | { code: 'DUPLICATE_EDGE'; relationId: string }
    | { code: 'RELATION_MISMATCH'; relationId: string };

/** The edge as the serializer and the converter hold it. */
export interface CandidateEdge {
    relationId: string;
    sourceElementId: string;
    targetElementId: string;
}

/** A relation of the book: its own two ends. */
export interface KnownRelation {
    relationId: string;
    sourceElementId: string;
    targetElementId: string;
}

/**
 * Every refusal for `edge` on a map whose nodes draw `elementIds` and whose
 * OTHER edges draw `drawnRelationIds`. `relation` is the book's relation of
 * that id, or undefined when the book holds none (also a mismatch).
 */
export function validateEdge(
    edge: CandidateEdge,
    elementIds: ReadonlySet<string>,
    drawnRelationIds: ReadonlySet<string>,
    relation: KnownRelation | undefined,
): EdgeRefusal[] {
    const out: EdgeRefusal[] = [];
    if (edge.sourceElementId === edge.targetElementId) {
        if (!elementIds.has(edge.sourceElementId)) out.push({ code: 'UNKNOWN_NODE', elementId: edge.sourceElementId });
        out.push({ code: 'SELF_LOOP', elementId: edge.sourceElementId });
    } else {
        if (!elementIds.has(edge.sourceElementId)) out.push({ code: 'UNKNOWN_NODE', elementId: edge.sourceElementId });
        if (!elementIds.has(edge.targetElementId)) out.push({ code: 'UNKNOWN_NODE', elementId: edge.targetElementId });
    }
    if (drawnRelationIds.has(edge.relationId)) out.push({ code: 'DUPLICATE_EDGE', relationId: edge.relationId });
    if (!relation || relation.sourceElementId !== edge.sourceElementId || relation.targetElementId !== edge.targetElementId) {
        out.push({ code: 'RELATION_MISMATCH', relationId: edge.relationId });
    }
    return out;
}

/** A refusal in plain words, for a thrown error's message (the UI words refusals from their codes). */
export function describeRefusal(r: EdgeRefusal): string {
    switch (r.code) {
        case 'UNKNOWN_NODE':
            return `No node for element ${r.elementId} on this map.`;
        case 'SELF_LOOP':
            return 'An element cannot be joined to itself.';
        case 'DUPLICATE_EDGE':
            return `Relation ${r.relationId} is already drawn on this map.`;
        case 'RELATION_MISMATCH':
            return `The edge does not join relation ${r.relationId}'s two elements.`;
    }
}
