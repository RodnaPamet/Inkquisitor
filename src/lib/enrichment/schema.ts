/**
 * The reconcile step's structured output (Phase 2.5; design 5.3), and the
 * item-by-item reader code uses on whatever the model returned.
 *
 * The schema is CODE, never built from author text (2.1: the API caches a
 * compiled schema outside the zero-retention scope), and stays within the
 * structured-output limits 2.1 checks when the request is built (an object
 * root, no record, no recursion, at most 24 optional and 16 union
 * parameters): every member is required, `value` is one union and
 * `summary` one nullable. So the element and its field are named per
 * operation (a KIND or BOOK round spans several elements).
 *
 * The model's answer is untrusted: `parseReconcileOutput` re-reads it item by
 * item, so one malformed operation costs only itself (counted MALFORMED), and
 * `validate.ts` holds every survivor to the rules.
 *
 * Phase 3.3 (decision D24): an operation's `elementId` is its SUBJECT's id (an
 * element's, a relation's, or the BETWEEN slot's `PENDING_SUBJECT_ID`); a new
 * element says whether it `fillsSlot` (the BETWEEN session's element not yet
 * created); and `newRelations` proposes links, each end an element of the
 * data's `relation_ends` or `new.N` (the N-th of this output's newElements, from
 * 1), with a note and the type's fields (prose: strings) drawn from the
 * answers. Still within 2.1's limits: every member required, one more nullable.
 */
import { z } from 'zod';
import { BIBLE_KINDS, IDENTIFIER_MAX, IDENTIFIER_PATTERN } from '@/lib/bible/kinds';
import { RECONCILE_OPS } from './vocabulary';

/** Operations one call may return (a round targets at most a few dozen fields). */
export const OPERATIONS_PER_CALL_MAX = 40;
/** New elements one call may propose. */
export const NEW_ELEMENTS_PER_CALL_MAX = 8;
/** Citations one proposal may carry. */
export const CITES_MAX = 20;
/** A proposed text value's raw length the reader accepts (the field's own bound applies after). */
export const VALUE_TEXT_RAW_MAX = 8_000;
export const VALUE_ITEMS_MAX = 60;
export const VALUE_ITEM_RAW_MAX = 1_000;
export const NEW_NAME_RAW_MAX = 240;
export const NEW_SUMMARY_RAW_MAX = 2_000;

/** The kinds a reconcile step may propose as a new element: every kind but CUSTOM, which needs a label of the author's. */
export const PROPOSABLE_KINDS = BIBLE_KINDS.filter((k) => k !== 'CUSTOM');

const fieldKey = z.string().max(IDENTIFIER_MAX).regex(IDENTIFIER_PATTERN);
const answerId = z.string().min(1).max(64);

/** One field's operation. `value`: text for text, rich text (plain paragraphs) and choice fields; items for a list; 1..5 for a scale; null for REMOVE and NO_CHANGE. */
export const ReconcileOperationSchema = z
    .object({
        elementId: z.string().min(1).max(64),
        fieldKey,
        op: z.enum(RECONCILE_OPS),
        value: z.union([z.string().max(VALUE_TEXT_RAW_MAX), z.array(z.string().max(VALUE_ITEM_RAW_MAX)).max(VALUE_ITEMS_MAX), z.number().int(), z.null()]),
        cites: z.array(answerId).max(CITES_MAX),
    })
    .strict();
export type ReconcileOperation = z.infer<typeof ReconcileOperationSchema>;

/** A new element an answer names that the book lacks. */
export const NewElementSchema = z
    .object({
        kind: z.enum(BIBLE_KINDS),
        name: z.string().max(NEW_NAME_RAW_MAX),
        summary: z.string().max(NEW_SUMMARY_RAW_MAX).nullable(),
        /** Phase 3.3: it is the BETWEEN session's element not yet created (its fields are the operations on the slot). */
        fillsSlot: z.boolean(),
        cites: z.array(answerId).max(CITES_MAX),
    })
    .strict();
export type NewElementOutput = z.infer<typeof NewElementSchema>;

/** New relations one call may propose (Phase 3.3). */
export const NEW_RELATIONS_PER_CALL_MAX = 8;
/** A new relation's fields, at most (a type declares at most four). */
export const NEW_RELATION_FIELDS_MAX = 4;
export const NEW_RELATION_NOTE_RAW_MAX = 8_000;

/** A new relation (Phase 3.3, D24): two ends, a type, a note and fields drawn from the answers. */
export const NewRelationSchema = z
    .object({
        /** An element id of the data's `relation_ends`, or `new.N` (the N-th new element of this output, from 1). */
        fromElementId: z.string().min(1).max(64),
        toElementId: z.string().min(1).max(64),
        type: fieldKey,
        note: z.string().max(NEW_RELATION_NOTE_RAW_MAX).nullable(),
        fields: z.array(z.object({ key: fieldKey, value: z.string().max(VALUE_TEXT_RAW_MAX) }).strict()).max(NEW_RELATION_FIELDS_MAX),
        cites: z.array(answerId).max(CITES_MAX),
    })
    .strict();
export type NewRelationOutput = z.infer<typeof NewRelationSchema>;

/** The whole output (design 5.3; Phase 3.3 adds `newRelations`). */
export const ReconcileOutputSchema = z
    .object({
        operations: z.array(ReconcileOperationSchema).max(OPERATIONS_PER_CALL_MAX),
        newElements: z.array(NewElementSchema).max(NEW_ELEMENTS_PER_CALL_MAX),
        newRelations: z.array(NewRelationSchema).max(NEW_RELATIONS_PER_CALL_MAX),
    })
    .strict();
export type ReconcileOutput = z.infer<typeof ReconcileOutputSchema>;

export interface ParsedReconcile {
    operations: ReconcileOperation[];
    /** Every new element as given, in output order (a refused item is `null`, so `new.N` still names the N-th). */
    newElements: Array<NewElementOutput | null>;
    newRelations: NewRelationOutput[];
    /** Items that did not parse, counted (never logged: they hold model text). */
    malformed: number;
    /** The whole output was not an object with an `operations` array. */
    unreadable: boolean;
}

function readItems<T>(raw: unknown, schema: z.ZodType<T>, max: number, out: { malformed: number }): T[] {
    return readItemsInPlace(raw, schema, max, out).filter((x): x is T => x !== null);
}

/** As `readItems`, keeping a malformed item's place as `null` (a new element is named by its position). */
function readItemsInPlace<T>(raw: unknown, schema: z.ZodType<T>, max: number, out: { malformed: number }): Array<T | null> {
    if (!Array.isArray(raw)) return [];
    const items: Array<T | null> = [];
    out.malformed += Math.max(0, raw.length - max);
    for (const item of raw.slice(0, max)) {
        const parsed = schema.safeParse(item);
        if (parsed.success) items.push(parsed.data);
        else {
            items.push(null);
            out.malformed++;
        }
    }
    return items;
}

/** Read a model's raw output one item at a time. */
export function parseReconcileOutput(raw: unknown): ParsedReconcile {
    const out: ParsedReconcile = { operations: [], newElements: [], newRelations: [], malformed: 0, unreadable: false };
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { operations?: unknown }).operations)) {
        out.unreadable = true;
        return out;
    }
    const r = raw as { operations: unknown; newElements?: unknown; newRelations?: unknown };
    out.operations = readItems(r.operations, ReconcileOperationSchema, OPERATIONS_PER_CALL_MAX, out);
    out.newElements = readItemsInPlace(r.newElements, NewElementSchema, NEW_ELEMENTS_PER_CALL_MAX, out);
    out.newRelations = readItems(r.newRelations, NewRelationSchema, NEW_RELATIONS_PER_CALL_MAX, out);
    return out;
}
