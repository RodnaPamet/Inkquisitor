/**
 * A relation version's snapshot (Phase 3.3, decision D24): the relation —
 * its type, its two ends, its note and every one of its fields — at the moment
 * of a save.
 *
 * Stored as a JSON STRING in `BibleRelationVersion.snapshot` (an encrypted
 * column: the extension seals strings, so it is serialised here and sealed
 * whole), as an element's snapshot is. Fields are in template order (then
 * key), so two saves of the same state serialise identically. A snapshot this
 * code cannot read is an error, never a silent empty relation.
 */
import { z } from 'zod';
import type { FieldValue } from './field-values';

export const RELATION_SNAPSHOT_FORMAT = 1;

export const relationSnapshotSchema = z
    .object({
        format: z.literal(RELATION_SNAPSHOT_FORMAT),
        relation: z.object({ type: z.string(), fromElementId: z.string(), toElementId: z.string(), note: z.string().nullable() }).strict(),
        fields: z.array(z.object({ key: z.string(), order: z.number().int(), value: z.string() }).strict()),
    })
    .strict();

export type RelationSnapshot = z.infer<typeof relationSnapshotSchema>;

export interface RelationSnapshotInput {
    relation: RelationSnapshot['relation'];
    fields: ReadonlyArray<{ key: string; order: number; value: FieldValue }>;
}

export function buildRelationSnapshot(input: RelationSnapshotInput): RelationSnapshot {
    const fields = [...input.fields]
        .filter((f): f is { key: string; order: number; value: string } => typeof f.value === 'string')
        .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((f) => ({ key: f.key, order: f.order, value: f.value }));
    const { type, fromElementId, toElementId, note } = input.relation;
    return { format: RELATION_SNAPSHOT_FORMAT, relation: { type, fromElementId, toElementId, note }, fields };
}

export function serialiseRelationSnapshot(snapshot: RelationSnapshot): string {
    return JSON.stringify(snapshot);
}

export function parseRelationSnapshot(text: string): RelationSnapshot {
    return relationSnapshotSchema.parse(JSON.parse(text));
}
