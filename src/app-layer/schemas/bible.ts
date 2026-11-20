/**
 * Request shapes for the bible API (Phase 1.1): books, elements, fields,
 * relations and versions. Every object is `.strict()`, so an unknown key is a
 * 400 rather than silently dropped.
 *
 * These bound the RAW input. The usecases then sanitise every text value
 * (`src/lib/security/sanitize.ts`) and check it again where sanitising can
 * empty it (a name of only markup is no name). A field value is checked
 * against its template's type by `normaliseFieldValue`
 * (`src/lib/bible/field-values.ts`), which needs the element's kind and so
 * runs in the usecase.
 */
import { z } from 'zod';
import { BIBLE_ELEMENT_STATUSES, BIBLE_KINDS, BOOK_STAGES, ELEMENT_NAME_MAX, IDENTIFIER_MAX, IDENTIFIER_PATTERN } from '@/lib/bible/kinds';
import { SLUG_MAX, SLUG_PATTERN } from '@/lib/bible/slug';
import { LIST_ITEMS_MAX, RAW_INPUT_FACTOR, rawListItemMax, rawStringMax } from '@/lib/bible/field-values';

export const BOOK_TITLE_MAX = 200;
export const BOOK_LOGLINE_MAX = 2_000;
export const BOOK_LABEL_MAX = 80;
export const BOOK_TARGET_LENGTH_MAX = 5_000_000;
export { ELEMENT_NAME_MAX };
export const ELEMENT_SUMMARY_MAX = 5_000;
export const CUSTOM_LABEL_MAX = 60;
export const CHANGE_SUMMARY_MAX = 500;
export const RELATION_NOTE_MAX = 2_000;
export const FIELDS_PER_SAVE_MAX = 50;

/** Raw text may carry markup the sanitiser removes; allow it some room before the post-sanitise bound. */
const raw = (max: number) => z.string().max(max * RAW_INPUT_FACTOR);
const id = z.string().min(1).max(64);
const identifier = z.string().max(IDENTIFIER_MAX).regex(IDENTIFIER_PATTERN);

/**
 * The version the writer's edit is based on (Phase 1.H): the element's latest
 * version number when the writer last read or saved it. A save that names one
 * and finds a newer version is refused 409 `VERSION_CONFLICT` (the optimistic
 * check, `assertBaseVersion`). REQUIRED on every request that saves an
 * element (a change, a fields save, a restore): the API's only writer is a
 * client, and a base it could leave out is a check it could skip, so an
 * omitted one is a 400, never an unchecked save. Writers inside the server
 * that do not take a request (the bundle and concept-note imports) do not go
 * through these inputs; they take the element's lock and save over whatever
 * stands, by design (an import is the file's whole state).
 */
export const BaseVersionInput = z.number().int().min(1).max(2_147_483_647);

const hasSomeKey =
    (...keys: string[]) =>
    (o: Record<string, unknown>) =>
        Object.keys(o).some((k) => !keys.includes(k));

// ─── Books ──────────────────────────────────────────────────────────

export const BookCreateInput = z
    .object({
        title: raw(BOOK_TITLE_MAX).min(1),
        logline: raw(BOOK_LOGLINE_MAX).nullish(),
        genre: raw(BOOK_LABEL_MAX).nullish(),
        audience: raw(BOOK_LABEL_MAX).nullish(),
        targetLength: z.number().int().min(1).max(BOOK_TARGET_LENGTH_MAX).nullish(),
        stage: z.enum(BOOK_STAGES).optional(),
    })
    .strict();
export type BookCreateInput = z.infer<typeof BookCreateInput>;

export const BookUpdateInput = BookCreateInput.partial().strict().refine(hasSomeKey(), { message: 'Nothing to change.' });
export type BookUpdateInput = z.infer<typeof BookUpdateInput>;

// ─── Elements and fields ────────────────────────────────────────────

/**
 * A field value's RAW shape, bounded before anything sanitises it. The schema
 * cannot see the field's type (that needs the element's kind), so a string is
 * held to the largest type's raw bound (rich text); `normaliseFieldValue` then
 * holds it to its own type's raw bound, still before sanitising. Without
 * these, a megabytes-long value was sanitised in full before being refused
 * TOO_LONG.
 */
export const FieldValueInput = z.union([
    z.string().max(rawStringMax()),
    z.number(),
    z.array(z.string().max(rawListItemMax())).max(LIST_ITEMS_MAX),
    z.null(),
]);

export const FieldEntryInput = z.object({ key: identifier, value: FieldValueInput }).strict();
export type FieldEntryInput = z.infer<typeof FieldEntryInput>;

export const ElementCreateInput = z
    .object({
        kind: z.enum(BIBLE_KINDS),
        name: raw(ELEMENT_NAME_MAX).min(1),
        slug: z.string().max(SLUG_MAX).regex(SLUG_PATTERN).optional(),
        status: z.enum(BIBLE_ELEMENT_STATUSES).optional(),
        summary: raw(ELEMENT_SUMMARY_MAX).nullish(),
        customLabel: raw(CUSTOM_LABEL_MAX).nullish(),
        fields: z.array(FieldEntryInput).max(FIELDS_PER_SAVE_MAX).optional(),
        changeSummary: raw(CHANGE_SUMMARY_MAX).nullish(),
    })
    .strict();
export type ElementCreateInput = z.infer<typeof ElementCreateInput>;

export const ElementUpdateInput = z
    .object({
        name: raw(ELEMENT_NAME_MAX).min(1).optional(),
        slug: z.string().max(SLUG_MAX).regex(SLUG_PATTERN).optional(),
        status: z.enum(BIBLE_ELEMENT_STATUSES).optional(),
        summary: raw(ELEMENT_SUMMARY_MAX).nullable().optional(),
        customLabel: raw(CUSTOM_LABEL_MAX).optional(),
        changeSummary: raw(CHANGE_SUMMARY_MAX).nullish(),
        baseVersion: BaseVersionInput,
    })
    .strict()
    .refine(hasSomeKey('changeSummary', 'baseVersion'), { message: 'Nothing to change.' });
export type ElementUpdateInput = z.infer<typeof ElementUpdateInput>;

export const FieldsUpdateInput = z
    .object({
        fields: z.array(FieldEntryInput).min(1).max(FIELDS_PER_SAVE_MAX),
        changeSummary: raw(CHANGE_SUMMARY_MAX).nullish(),
        baseVersion: BaseVersionInput,
    })
    .strict();
export type FieldsUpdateInput = z.infer<typeof FieldsUpdateInput>;

/** Elements a page of the element list holds by default, and at most (Phase 1.H). */
export const ELEMENT_PAGE_DEFAULT = 100;
export const ELEMENT_PAGE_MAX = 200;

/**
 * One page of a book's elements, by name (Phase 1.H, #18): of one kind or of
 * several (the relation picker), whose name contains `q`, after the cursor
 * the previous page answered.
 */
export const ElementListQuery = z
    .object({
        kind: z.enum(BIBLE_KINDS).optional(),
        kinds: z.array(z.enum(BIBLE_KINDS)).min(1).max(BIBLE_KINDS.length).optional(),
        q: z.string().max(ELEMENT_NAME_MAX).optional(),
        after: z.string().max(1_000).optional(),
        take: z.coerce.number().int().min(1).max(ELEMENT_PAGE_MAX).optional(),
    })
    .strict();
export type ElementListQuery = z.infer<typeof ElementListQuery>;

// ─── Relations ──────────────────────────────────────────────────────

export const RelationCreateInput = z
    .object({
        fromElementId: id,
        toElementId: id,
        type: identifier,
        note: raw(RELATION_NOTE_MAX).nullish(),
    })
    .strict();
export type RelationCreateInput = z.infer<typeof RelationCreateInput>;

// ─── Versions ───────────────────────────────────────────────────────

export const VersionNumberParam = z.coerce.number().int().min(1).max(2_147_483_647);

export const RestoreInput = z.object({ changeSummary: raw(CHANGE_SUMMARY_MAX).nullish(), baseVersion: BaseVersionInput }).strict();
export type RestoreInput = z.infer<typeof RestoreInput>;
