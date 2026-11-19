/**
 * A bible version's snapshot: the element and every one of its fields at the
 * moment of a save (Phase 1.1).
 *
 * Stored as a JSON STRING in `BibleEntryVersion.snapshot`, a column of the
 * encrypted-fields manifest: the encryption extension seals strings, so the
 * snapshot is serialised here first and sealed whole, rather than kept as a
 * JSON column whose leaves no extension would reach. Reading one back parses
 * it against the schema below; a snapshot this code cannot read is an error,
 * never a silent empty element.
 *
 * Fields are in template order (then key), so two saves of the same state
 * serialise identically.
 */
import { z } from 'zod';
import { BIBLE_ELEMENT_STATUSES, BIBLE_KINDS } from './kinds';
import type { FieldValue } from './field-values';

export const SNAPSHOT_FORMAT = 1;

const fieldValue = z.union([z.string(), z.number(), z.array(z.string())]);

export const snapshotSchema = z
    .object({
        format: z.literal(SNAPSHOT_FORMAT),
        element: z
            .object({
                kind: z.enum(BIBLE_KINDS),
                name: z.string(),
                slug: z.string(),
                status: z.enum(BIBLE_ELEMENT_STATUSES),
                summary: z.string().nullable(),
                customLabel: z.string().nullable(),
            })
            .strict(),
        fields: z.array(z.object({ key: z.string(), order: z.number().int(), value: fieldValue }).strict()),
    })
    .strict();

export type BibleSnapshot = z.infer<typeof snapshotSchema>;

export interface SnapshotInput {
    element: BibleSnapshot['element'];
    fields: ReadonlyArray<{ key: string; order: number; value: FieldValue }>;
}

export function buildSnapshot(input: SnapshotInput): BibleSnapshot {
    const fields = [...input.fields]
        .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((f) => ({ key: f.key, order: f.order, value: f.value }));
    const { kind, name, slug, status, summary, customLabel } = input.element;
    return { format: SNAPSHOT_FORMAT, element: { kind, name, slug, status, summary, customLabel }, fields };
}

export function serialiseSnapshot(snapshot: BibleSnapshot): string {
    return JSON.stringify(snapshot);
}

export class SnapshotUnreadableError extends Error {
    constructor() {
        super('bible version snapshot does not match the snapshot format');
        this.name = 'SnapshotUnreadableError';
    }
}

export function parseSnapshot(stored: string): BibleSnapshot {
    let raw: unknown;
    try {
        raw = JSON.parse(stored);
    } catch {
        throw new SnapshotUnreadableError();
    }
    const parsed = snapshotSchema.safeParse(raw);
    if (!parsed.success) throw new SnapshotUnreadableError();
    return parsed.data;
}
