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
import { BIBLE_ELEMENT_STATUSES, BIBLE_KINDS, BOOK_STAGES, IDENTIFIER_MAX, IDENTIFIER_PATTERN } from '@/lib/bible/kinds';
import { SLUG_MAX, SLUG_PATTERN } from '@/lib/bible/slug';

export const BOOK_TITLE_MAX = 200;
export const BOOK_LOGLINE_MAX = 2_000;
export const BOOK_LABEL_MAX = 80;
export const BOOK_TARGET_LENGTH_MAX = 5_000_000;
export const ELEMENT_NAME_MAX = 120;
export const ELEMENT_SUMMARY_MAX = 5_000;
export const CUSTOM_LABEL_MAX = 60;
export const CHANGE_SUMMARY_MAX = 500;
export const RELATION_NOTE_MAX = 2_000;
export const FIELDS_PER_SAVE_MAX = 50;

/** Raw text may carry markup the sanitiser removes; allow it some room before the post-sanitise bound. */
const raw = (max: number) => z.string().max(max * 4);
const id = z.string().min(1).max(64);
const identifier = z.string().max(IDENTIFIER_MAX).regex(IDENTIFIER_PATTERN);

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

export const FieldValueInput = z.union([z.string(), z.number(), z.array(z.string()), z.null()]);

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
    })
    .strict()
    .refine(hasSomeKey('changeSummary'), { message: 'Nothing to change.' });
export type ElementUpdateInput = z.infer<typeof ElementUpdateInput>;

export const FieldsUpdateInput = z
    .object({
        fields: z.array(FieldEntryInput).min(1).max(FIELDS_PER_SAVE_MAX),
        changeSummary: raw(CHANGE_SUMMARY_MAX).nullish(),
    })
    .strict();
export type FieldsUpdateInput = z.infer<typeof FieldsUpdateInput>;

export const ElementListQuery = z.object({ kind: z.enum(BIBLE_KINDS).optional() }).strict();

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

export const RestoreInput = z.object({ changeSummary: raw(CHANGE_SUMMARY_MAX).nullish() }).strict();
export type RestoreInput = z.infer<typeof RestoreInput>;
