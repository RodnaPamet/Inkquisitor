/**
 * The freeform layer on its way into storage (Phase 3.1).
 *
 * Sticky notes, loose text, drawings and frames are the renderer's own
 * records, carried opaquely in `StoryMap.freeformJson`: the server does not
 * understand them and must not start to (the moment it reads one, somebody
 * will derive a bible fact from a doodle). But they ARE author text, so the
 * layer is bounded, shape-checked and sanitised here before it is stored
 * (encrypted, as the manifest lists it):
 *
 *   1. bounded: at most FREEFORM_MAX_RECORDS records and FREEFORM_MAX_BYTES of
 *      JSON, nested at most FREEFORM_MAX_DEPTH deep;
 *   2. shaped: every record is an object with an id of tldraw's shape
 *      (`shape:…` / `binding:…`) and a typeName of `shape` or `binding`; a
 *      record of the canvas's own types (a node, an edge, an edge line) is
 *      refused, because those are rows or are derived from rows, and a copy
 *      in the freeform layer would be restored ON TOP of the real one;
 *   3. no prototype keys: `__proto__`, `constructor` and `prototype` are
 *      refused at any depth. JSON.parse makes `__proto__` an own key, and a
 *      rich-text editor that merges attributes from stored JSON is exactly
 *      where that becomes an inherited attribute (GHSA-cp6q-959q-f8rh);
 *   4. sanitised: every string leaf loses its control characters and is run
 *      through `sanitizePlainText` (tags stripped, entities decoded) — the
 *      same treatment a bible field's plain text gets, without the trimming,
 *      which would join the words either side of a bold run.
 *
 *   5. no row's id: a record may not carry the id the canvas gives a node
 *      (`shape:<elementId>`), an edge's line (`shape:edge-<relationId>`) or an
 *      edge's binding (`binding:<relationId>`) of the same save
 *      (`assertFreeformIdsFree`). tldraw's create APIs replace a record of the
 *      same id, so such a record would be drawn over the node or edge on load.
 *
 * Refusals throw `ValidationError` with a `reason` the UI words
 * (`FREEFORM_REFUSED`, `details.problem`). An empty layer is stored as NULL.
 */
import { stripControlChars } from '@/lib/bible/text';
import { ValidationError } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { FREEFORM_MAX_BYTES, FREEFORM_MAX_DEPTH, FREEFORM_MAX_RECORDS } from './limits';
import { STRUCTURED_RECORD_TYPES } from './shape-types';

export type FreeformProblem =
    | 'NOT_A_LIST'
    | 'TOO_MANY_RECORDS'
    | 'TOO_LARGE'
    | 'TOO_DEEP'
    | 'NOT_A_RECORD'
    | 'BAD_ID'
    | 'BAD_TYPE_NAME'
    | 'STRUCTURED_TYPE'
    | 'FORBIDDEN_KEY'
    | 'DUPLICATE_ID'
    | 'RESERVED_ID';

const RECORD_ID = /^(?:shape|binding):[A-Za-z0-9_-]{1,128}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function refuse(problem: FreeformProblem, index?: number): never {
    throw new ValidationError('The canvas drawing layer could not be saved.', {
        reason: 'FREEFORM_REFUSED',
        problem,
        ...(index !== undefined ? { index } : {}),
    });
}

/** A string leaf, as stored: no control characters, no markup. Cheap when it holds neither `<` nor `&`. */
function cleanString(s: string): string {
    const stripped = stripControlChars(s);
    if (!stripped.includes('<') && !stripped.includes('&')) return stripped;
    return stripControlChars(sanitizePlainText(stripped));
}

function cleanValue(value: unknown, depth: number, index: number): unknown {
    if (depth > FREEFORM_MAX_DEPTH) refuse('TOO_DEEP', index);
    if (typeof value === 'string') return cleanString(value);
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((v) => cleanValue(v, depth + 1, index));
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            if (FORBIDDEN_KEYS.has(key)) refuse('FORBIDDEN_KEY', index);
            out[key] = cleanValue((value as Record<string, unknown>)[key], depth + 1, index);
        }
        return out;
    }
    // undefined, a function, a bigint: nothing JSON could have carried.
    return refuse('NOT_A_RECORD', index);
}

/** The layer as checked, sanitised records (the client's shape, minus what is refused or cleaned). */
export function sanitiseFreeformRecords(input: unknown): Record<string, unknown>[] {
    if (!Array.isArray(input)) refuse('NOT_A_LIST');
    if (input.length > FREEFORM_MAX_RECORDS) refuse('TOO_MANY_RECORDS');
    const seen = new Set<string>();
    return input.map((record, index) => {
        if (typeof record !== 'object' || record === null || Array.isArray(record)) refuse('NOT_A_RECORD', index);
        const r = record as Record<string, unknown>;
        if (typeof r.id !== 'string' || !RECORD_ID.test(r.id)) refuse('BAD_ID', index);
        if (r.typeName !== 'shape' && r.typeName !== 'binding') refuse('BAD_TYPE_NAME', index);
        if (typeof r.type === 'string' && STRUCTURED_RECORD_TYPES.has(r.type)) refuse('STRUCTURED_TYPE', index);
        if (seen.has(r.id)) refuse('DUPLICATE_ID', index);
        seen.add(r.id);
        return cleanValue(r, 1, index) as Record<string, unknown>;
    });
}

/**
 * The layer as `StoryMap.freeformJson` stores it: the sanitised records as a
 * JSON string, or NULL for an empty layer. Refuses past the byte bound,
 * measured on what would be stored.
 */
export function sanitiseFreeformForStorage(input: unknown): string | null {
    const records = sanitiseFreeformRecords(input);
    if (records.length === 0) return null;
    const json = JSON.stringify(records);
    if (Buffer.byteLength(json, 'utf8') > FREEFORM_MAX_BYTES) refuse('TOO_LARGE');
    return json;
}

/**
 * The ids the canvas derives from a map's rows: a node's shape is
 * `shape:<elementId>`, an edge's line `shape:edge-<relationId>`, an edge's
 * binding `binding:<relationId>` (`story-node-shape.ts`, `story-edge-shape.ts`,
 * `story-edge-binding.ts`; `tests/unit/canvas/freeform.test.ts` holds the
 * spellings equal). Plain strings, so the server needs no tldraw import.
 */
export function rowRecordIds(nodes: readonly { elementId: string }[], edges: readonly { relationId: string }[]): Set<string> {
    const ids = new Set<string>();
    for (const n of nodes) ids.add(`shape:${n.elementId}`);
    for (const e of edges) {
        ids.add(`shape:edge-${e.relationId}`);
        ids.add(`binding:${e.relationId}`);
    }
    return ids;
}

/** Refuse a freeform record carrying the id of one of the same save's nodes or edges (see the header, 5). */
export function assertFreeformIdsFree(
    freeform: readonly Record<string, unknown>[],
    nodes: readonly { elementId: string }[],
    edges: readonly { relationId: string }[],
): void {
    const reserved = rowRecordIds(nodes, edges);
    freeform.forEach((r, index) => {
        if (typeof r.id === 'string' && reserved.has(r.id)) refuse('RESERVED_ID', index);
    });
}

/** The stored layer read back; a NULL or unreadable value is an empty layer, never a throw. */
export function parseStoredFreeform(stored: string | null): Record<string, unknown>[] {
    if (!stored) return [];
    try {
        const parsed: unknown = JSON.parse(stored);
        return Array.isArray(parsed) ? (parsed.filter((r) => typeof r === 'object' && r !== null) as Record<string, unknown>[]) : [];
    } catch {
        return [];
    }
}
