/**
 * Shapes for the bible's import and export (Phase 1.3): the Markdown
 * bundle's manifest and frontmatter, the bundle import's options and the
 * concept-note request. Every object is `.strict()`: an unknown key is
 * refused by name, never dropped.
 *
 * Like the 1.1 request shapes (`./bible.ts`) these bound the RAW input, up to
 * `RAW_INPUT_FACTOR` times what may be stored; the import usecase then
 * sanitises every value through the same paths as a manual save
 * (`requiredLine`, `optionalBlock`, `normaliseFieldValue`) and checks the
 * stored bounds on what is left.
 */
import { z } from 'zod';
import { BIBLE_ELEMENT_STATUSES, BIBLE_KINDS, BOOK_STAGES, IDENTIFIER_MAX, IDENTIFIER_PATTERN } from '@/lib/bible/kinds';
import { SLUG_MAX, SLUG_PATTERN } from '@/lib/bible/slug';
import { BUNDLE_FORMAT } from '@/lib/bible/bundle-format';
import { BUNDLE_UPLOAD_MAX_BYTES, CONCEPT_NOTE_MAX } from '@/lib/bible/transfer-limits';
import { LIST_ITEMS_MAX, RAW_INPUT_FACTOR, rawListItemMax, rawStringMax } from '@/lib/bible/field-values';
import {
    BOOK_LABEL_MAX,
    BOOK_LOGLINE_MAX,
    BOOK_TARGET_LENGTH_MAX,
    BOOK_TITLE_MAX,
    CUSTOM_LABEL_MAX,
    ELEMENT_NAME_MAX,
    ELEMENT_SUMMARY_MAX,
    FIELDS_PER_SAVE_MAX,
    RELATION_NOTE_MAX,
} from './bible';

const raw = (max: number) => z.string().max(max * RAW_INPUT_FACTOR);
const identifier = z.string().max(IDENTIFIER_MAX).regex(IDENTIFIER_PATTERN);
const slug = z.string().max(SLUG_MAX).regex(SLUG_PATTERN);

// ─── Bounds ─────────────────────────────────────────────────────────

export { BUNDLE_UPLOAD_MAX_BYTES, CONCEPT_NOTE_MAX };

/** The most elements a bundle may carry, and an export may hold. */
export const BUNDLE_MAX_ELEMENTS = 2_000;
/** The most relations one element file may declare. */
export const BUNDLE_MAX_RELATIONS_PER_ELEMENT = 200;
/** The most relations a book's export may hold. */
export const BUNDLE_MAX_RELATIONS = 20_000;
/** The zip reader's bounds for a bundle (src/lib/archive/zip.ts). */
export const BUNDLE_ZIP_LIMITS = {
    /** Every element, an index per kind, book.md, manifest.json, and room for directory entries. */
    maxEntries: BUNDLE_MAX_ELEMENTS + 2 * BIBLE_KINDS.length + 2,
    /**
     * One file, inflated: 2 MiB. Also the longest the import holds the event
     * loop: it yields between files, and the densest YAML parses at about
     * 1.5 µs a character, so ~3 s (Phase 1.H, #27; it was 8 MiB, ~12 s).
     */
    maxEntryBytes: 2 * 1024 * 1024,
    /**
     * Every file, inflated: 24 MiB, an average of 12 KiB for each of the
     * 2,000 elements a bundle may carry (a full CHARACTER file of ordinary
     * prose is 3–6 KiB). The densest YAML that fits costs ~35 s of CPU,
     * spread file by file; it was 64 MiB, ~90 s (Phase 1.H, #27).
     */
    maxTotalBytes: 24 * 1024 * 1024,
    /** Inflated over compressed, for an entry past the exempt size. */
    maxRatio: 100,
} as const;
/** Refusals listed in one answer, at most; past it the report says it was cut. */
export const BUNDLE_MAX_PROBLEMS = 100;

// ─── The bundle's files ─────────────────────────────────────────────

/** The most field keys `templateFields` may list for one kind (a template has a few dozen at most). */
const TEMPLATE_FIELDS_PER_KIND_MAX = 200;

export const BundleManifest = z
    .object({
        format: z.literal(BUNDLE_FORMAT),
        version: z.number().int(),
        /**
         * Per kind directory, the template field keys the bundle's writer
         * knew: an element file clears only these when it leaves one out.
         * Absent (a hand-written manifest): every current template key.
         */
        templateFields: z
            .partialRecord(z.enum(BIBLE_KINDS.map((k) => k.toLowerCase()) as [string, ...string[]]), z.array(identifier).max(TEMPLATE_FIELDS_PER_KIND_MAX))
            .optional(),
    })
    .strict();
export type BundleManifest = z.infer<typeof BundleManifest>;

export const BundleBookFrontmatter = z
    .object({
        title: raw(BOOK_TITLE_MAX).min(1),
        logline: raw(BOOK_LOGLINE_MAX).optional(),
        genre: raw(BOOK_LABEL_MAX).optional(),
        audience: raw(BOOK_LABEL_MAX).optional(),
        targetLength: z.number().int().min(1).max(BOOK_TARGET_LENGTH_MAX).optional(),
        stage: z.enum(BOOK_STAGES),
    })
    .strict();
export type BundleBookFrontmatter = z.infer<typeof BundleBookFrontmatter>;

const BundleFieldValue = z.union([z.string().max(rawStringMax()), z.number(), z.array(z.string().max(rawListItemMax())).max(LIST_ITEMS_MAX)]);

export const BundleRelationEntry = z
    .object({
        type: identifier,
        to: slug,
        note: raw(RELATION_NOTE_MAX).optional(),
    })
    .strict();

export const BundleElementFrontmatter = z
    .object({
        kind: z.enum(BIBLE_KINDS),
        name: raw(ELEMENT_NAME_MAX).min(1),
        slug,
        status: z.enum(BIBLE_ELEMENT_STATUSES),
        customLabel: raw(CUSTOM_LABEL_MAX).optional(),
        summary: raw(ELEMENT_SUMMARY_MAX).optional(),
        fields: z
            .record(identifier, BundleFieldValue)
            .refine((f) => Object.keys(f).length <= FIELDS_PER_SAVE_MAX, { message: 'Too many fields.' })
            .optional(),
        relations: z.array(BundleRelationEntry).max(BUNDLE_MAX_RELATIONS_PER_ELEMENT).optional(),
    })
    .strict();
export type BundleElementFrontmatter = z.infer<typeof BundleElementFrontmatter>;

// ─── Requests ───────────────────────────────────────────────────────

/** The bundle import's options, from the query string: `?bookDetails=apply` also applies book.md to the book. */
export const BundleImportOptions = z
    .object({
        bookDetails: z.enum(['apply', 'keep']).default('keep'),
    })
    .strict();
export type BundleImportOptions = z.infer<typeof BundleImportOptions>;

export const ConceptNoteInput = z
    .object({
        /** The element's name; derived from the note's first line when absent. */
        name: raw(ELEMENT_NAME_MAX).nullish(),
        /** The element's slug; derived from the name when absent. Importing again under one slug updates that element. */
        slug: slug.optional(),
        text: raw(CONCEPT_NOTE_MAX).min(1),
    })
    .strict();
export type ConceptNoteInput = z.infer<typeof ConceptNoteInput>;
