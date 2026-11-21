/**
 * Bringing a bible in (Phase 1.3): a Markdown bundle (the export's own format,
 * `src/lib/bible/bundle-format.ts`) or a free-text concept note. Both need
 * `bible.edit`.
 *
 * EVERY UPLOAD, in this order, before anything is written:
 *
 *   1. bounded — the route reads at most `BUNDLE_UPLOAD_MAX_BYTES` of a bundle
 *      (`readBoundedBytes`, 413 past it) and `readJsonBody`'s 2 MiB of a note;
 *   2. virus-scanned — the upload's bytes through ClamAV (`scanBuffer`):
 *      INFECTED is always refused (`UPLOAD_INFECTED`); a scan that could not
 *      run is refused in `strict` mode (`SCAN_UNAVAILABLE`, 503) and let
 *      through, with a warning, in `permissive` / `disabled` — the storage
 *      module's download policy (`isDownloadAllowed`) applied to an upload;
 *   3. unpacked within bounds — `readZip` refuses a zip bomb (entry count,
 *      each entry's and the total inflated size, the compression ratio),
 *      unsafe names and corrupt entries before and while inflating;
 *   4. parsed safely — YAML 1.2 core schema, no alias, no tag, no duplicate
 *      key, every object strict (`src/app-layer/schemas/bible-transfer.ts`);
 *   5. validated against the templates and sanitised through the SAME paths
 *      as a manual save: `requiredLine` / `optionalBlock` / `customLabelFor`
 *      for the columns, `normaliseFieldEntries` (`normaliseFieldValue`) for
 *      the fields. An unknown kind, field key, choice option or relation type
 *      is REFUSED with a named reason, never dropped.
 *
 * A BUNDLE IS ATOMIC. Every problem the bundle has is collected (up to
 * `BUNDLE_MAX_PROBLEMS`) and answered as one refusal,
 * `BUNDLE_REFUSED` with `problems: [{ path, reason, key? }]`; nothing is
 * written. A bundle that passes is written in ONE transaction, so a failure
 * part-way (a slug taken concurrently, a database error) leaves the book as
 * it was. Imports into one book are serialised by an advisory lock.
 *
 * IDEMPOTENT PER SLUG. An element file names its element by slug: a slug the
 * book does not hold is created; one it holds (of the same kind — another
 * kind is `KIND_CONFLICT`) is brought to exactly the file's state, the file
 * being the element's whole state over the template keys its writer knew
 * (the manifest's `templateFields`): a field the file leaves out is cleared,
 * unless the template gained it after the bundle was written.
 * Each element save goes through the versioned save (`bible-common.ts`: lock,
 * change, `recordVersion`) with source `IMPORT`, and a save that changes
 * nothing writes no version — so importing one bundle twice writes nothing
 * the second time, and re-importing a changed element writes one version.
 * Elements the bundle does not name are left alone: an import merges, it
 * never deletes.
 *
 * RELATIONS are resolved by slug after every element exists, against the
 * bundle and the book, from the element whose file lists them (which must be
 * the kind that declares the type). An existing relation is kept, its note
 * brought to the file's; none is removed. A relation the bundle states twice
 * is refused (`DUPLICATE_RELATION`).
 *
 * A bundle a desktop zipped as a folder (`<folder>/manifest.json`, …) is
 * read from inside that folder (`unwrapBundleFolder`).
 *
 * BOOK DETAILS (`book.md`) are applied only when asked (`bookDetails=apply`),
 * so importing into a book with its own title never renames it by surprise.
 *
 * A CONCEPT NOTE is pasted or uploaded plain text, stored as a RESEARCH
 * element: the text as paragraphs in its `notes` field (rich text), the name
 * given or taken from the note's first line. It is not parsed (Phase 2 may
 * read it with a model). A note ALWAYS makes a new element and never touches
 * an existing one (#27 item 3, owner decision 2026-11-19): its derived slug
 * is the first free candidate (`freeSlug`: `my-idea`, then `my-idea-2`, …),
 * whatever kind holds the taken ones, so importing one note twice makes two
 * elements. A slug the author SUPPLIES that is taken is a 409 `SLUG_TAKEN`.
 * Only the bundle is idempotent per slug.
 *
 * Nothing uploaded is stored as a file: the bytes are read, checked and
 * applied in memory, and only the resulting rows (author text encrypted at
 * rest) remain. The audit rows carry ids and counts, never text.
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleRelationRepository, type ElementWrite } from '@/app-layer/repositories/bible.repository';
import { BookRepository, type BookWrite } from '@/app-layer/repositories/book.repository';
import { ELEMENT_NAME_MAX, ELEMENT_SUMMARY_MAX, RELATION_NOTE_MAX } from '@/app-layer/schemas/bible';
import {
    BUNDLE_MAX_ELEMENTS,
    BUNDLE_MAX_PROBLEMS,
    BUNDLE_ZIP_LIMITS,
    BundleBookFrontmatter,
    BundleElementFrontmatter,
    BundleImportOptions,
    BundleManifest,
    CONCEPT_NOTE_MAX,
    ConceptNoteInput,
} from '@/app-layer/schemas/bible-transfer';
import { readZip, ZipRefusal } from '@/lib/archive/zip';
import {
    BOOK_FILE,
    BUNDLE_VERSION,
    decodeUtf8,
    FrontmatterError,
    frontmatterOf,
    INDEX_FILE,
    kindDirectory,
    kindOfDirectory,
    MANIFEST_FILE,
    parseYamlFrontmatter,
    sortElements,
} from '@/lib/bible/bundle-format';
import { isOrderedKind, ORDERED_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { isRank } from '@/lib/bible/story-order';
import { SLUG_PATTERN, slugify } from '@/lib/bible/slug';
import { coerceImportedFieldValue } from '@/lib/bible/field-coercion';
import { getRelationType, getTemplate, isSymmetric, relationAllowed } from '@/lib/bible/templates';
import { plainBlock } from '@/lib/bible/text';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { AppError, DomainError, ValidationError } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { scanBuffer, scanMode, type ScanResult } from '@/lib/storage/av-scan';
import {
    customLabelFor,
    DERIVED_SLUG_ATTEMPTS,
    freeSlug,
    isUniqueViolation,
    normaliseFieldEntries,
    optionalBlock,
    recordVersion,
    requireBook,
    requiredLine,
    slugConflict,
    writeFieldValues,
    type FieldEntry,
} from './bible-common';
import { bookWrite } from './books';
import { normaliseRelationFieldEntries, recordRelationVersion, relationForSave, writeRelationFieldValues } from './relation-common';

// ─── Shared ─────────────────────────────────────────────────────────

export interface ImportDeps {
    /** The virus scanner; ClamAV (`scanBuffer`) unless a test injects one. */
    scan?: (bytes: Buffer) => Promise<ScanResult>;
}

/** A bundle's import can touch thousands of rows: its one transaction may run this long. */
const IMPORT_TX_TIMEOUT_MS = 120_000;

/** The upload through the virus scanner, refused unless the storage policy lets it through. */
export async function assertUploadClean(ctx: WorkspaceRequestContext, bytes: Uint8Array, deps: ImportDeps, what: 'bundle' | 'concept-note' | 'research-source' | 'source'): Promise<void> {
    const result = await (deps.scan ?? scanBuffer)(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (result.status === 'CLEAN') return;
    if (result.status === 'INFECTED') {
        logger.warn('bible import refused: the virus scan found a threat', { component: 'bible-import', workspaceId: ctx.workspaceId, upload: what, threat: result.threat ?? 'unknown' });
        throw new ValidationError('The upload was refused by the virus scan.', { reason: 'UPLOAD_INFECTED' });
    }
    if (scanMode() === 'strict') {
        logger.warn('bible import refused: the virus scan could not run', { component: 'bible-import', workspaceId: ctx.workspaceId, upload: what, engine: result.engine });
        throw new DomainError('The virus scan is unavailable; try again shortly.', 'EXTERNAL_SERVICE_ERROR', 503, { reason: 'SCAN_UNAVAILABLE' });
    }
    logger.warn('bible import let through unscanned (scan mode is not strict)', { component: 'bible-import', workspaceId: ctx.workspaceId, upload: what, scanMode: scanMode() });
}

/** The reason an app error names, or null. */
function reasonOf(err: unknown): string | null {
    if (!(err instanceof AppError)) return null;
    const details = err.details as { reason?: unknown } | undefined;
    return typeof details?.reason === 'string' ? details.reason : null;
}

// ─── The bundle ─────────────────────────────────────────────────────

export interface ImportProblem {
    /** The file in the bundle the problem is in ('' for the archive as a whole). */
    path: string;
    reason: string;
    /** The field, column or relation target the problem is about, when it is about one. */
    key?: string;
}

class Problems {
    readonly list: ImportProblem[] = [];
    truncated = false;
    add(problem: ImportProblem): void {
        if (this.list.length < BUNDLE_MAX_PROBLEMS) this.list.push(problem);
        else this.truncated = true;
    }
    get any(): boolean {
        return this.list.length > 0;
    }
    refusal(): ValidationError {
        return new ValidationError('The bundle was refused; nothing was imported.', { reason: 'BUNDLE_REFUSED', problems: this.list, truncated: this.truncated });
    }
}

/** Files a desktop adds when it zips a folder; never part of a bundle, skipped by name. */
function isDesktopLitter(path: string): boolean {
    const base = path.split('/').pop() ?? '';
    return path.startsWith('__MACOSX/') || base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini';
}

/**
 * A desktop zips a folder as `<folder>/…` (Finder's Compress, Windows's
 * "Compressed folder"), so an exported bundle unzipped, edited and zipped
 * again arrives one folder down. When the archive's root holds no manifest
 * but every entry (desktop litter aside) sits in one folder that does, that
 * folder is read as the bundle. Anything else is left as it came, and
 * refused or read as it stands.
 */
export function unwrapBundleFolder(entries: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> {
    if (entries.has(MANIFEST_FILE)) return entries;
    const names = [...entries.keys()].filter((name) => !isDesktopLitter(name));
    if (names.length === 0) return entries;
    const prefix = `${names[0].split('/')[0]}/`;
    if (!names.every((name) => name.startsWith(prefix)) || !entries.has(`${prefix}${MANIFEST_FILE}`)) return entries;
    const out = new Map<string, Uint8Array>();
    for (const [name, bytes] of entries) if (name.startsWith(prefix)) out.set(name.slice(prefix.length), bytes);
    return out;
}

interface PreparedElement {
    path: string;
    kind: BibleKind;
    name: string;
    slug: string;
    status: 'DRAFT' | 'IN_PROGRESS' | 'SETTLED';
    customLabel: string | null;
    summary: string | null;
    /**
     * Its place in its story order (Phase 3.2): the file's rank, or undefined
     * when the file states none, which leaves the element's place as it stands
     * (a bundle written before 3.2, or an element not placed yet).
     */
    orderRank: string | undefined;
    /**
     * Every template field the file gives, and every one its writer knew and
     * it leaves out (null: the file is the element's whole state over the
     * keys it knew), then any unknown key (refused).
     */
    fields: FieldEntry[];
    /** Phase 3.3 (D24): each relation's fields as the file gives them (set; a field the file leaves out is kept). */
    relations: Array<{ type: string; to: string; note: string | null; fields: FieldEntry[] }>;
}

/** The YAML frontmatter of one file, as JavaScript values, or a problem. */
function frontmatterValue(path: string, bytes: Uint8Array, problems: Problems): unknown {
    try {
        return parseYamlFrontmatter(frontmatterOf(decodeUtf8(bytes)));
    } catch (err) {
        if (err instanceof FrontmatterError) {
            problems.add({ path, reason: err.reason });
            return undefined;
        }
        throw err;
    }
}

/** A Zod failure as problems: the keys it names, never the values. */
function schemaProblems(path: string, reason: string, issues: ReadonlyArray<{ path: PropertyKey[]; code: string; keys?: string[] }>, problems: Problems): void {
    for (const issue of issues) {
        if (issue.code === 'unrecognized_keys' && issue.keys) {
            for (const k of issue.keys) problems.add({ path, reason: 'UNKNOWN_KEY', key: [...issue.path.map(String), k].join('.') });
        } else {
            problems.add({ path, reason, key: issue.path.map(String).join('.') || undefined });
        }
    }
}

/**
 * Sanitise and check one element file's frontmatter, as a manual save would.
 * `knownKeys` are the template keys the bundle's writer knew for this kind
 * (the manifest's `templateFields`), or null for every current key: a known
 * key the file leaves out is cleared, any other is left alone.
 */
function prepareElement(path: string, fm: BundleElementFrontmatter, knownKeys: ReadonlySet<string> | null, problems: Problems): PreparedElement | null {
    let ok = true;
    const attempt = <T>(key: string, fn: () => T): T | undefined => {
        try {
            return fn();
        } catch (err) {
            const reason = reasonOf(err);
            if (!reason) throw err;
            problems.add({ path, reason, key });
            ok = false;
            return undefined;
        }
    };
    const name = attempt('name', () => requiredLine(fm.name, ELEMENT_NAME_MAX, 'Name'));
    const summary = attempt('summary', () => optionalBlock(fm.summary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null);
    const customLabel = attempt('customLabel', () => customLabelFor(fm.kind, fm.customLabel));
    if (fm.order !== undefined) {
        if (!isOrderedKind(fm.kind)) {
            problems.add({ path, reason: 'ORDER_NOT_ALLOWED', key: 'order' });
            ok = false;
        } else if (!isRank(fm.order)) {
            problems.add({ path, reason: 'ORDER_INVALID', key: 'order' });
            ok = false;
        }
    }

    // A field whose template type changed since the bundle was written: a
    // lossless coercion, or FIELD_TYPE_CHANGED naming it (issue #27, item 8;
    // `src/lib/bible/field-coercion.ts`). A value in the current shape is untouched.
    const given: Record<string, unknown> = { ...(fm.fields ?? {}) };
    for (const def of getTemplate(fm.kind).fields) {
        if (!Object.hasOwn(given, def.key)) continue;
        const c = coerceImportedFieldValue(def, given[def.key]);
        if (c.ok) given[def.key] = c.value;
        else {
            problems.add({ path, reason: c.reason, key: `fields.${def.key}` });
            ok = false;
            delete given[def.key];
        }
    }
    const templateKeys = getTemplate(fm.kind).fields.map((f) => f.key);
    const fields: FieldEntry[] = [
        ...templateKeys
            .filter((key) => Object.hasOwn(given, key) || knownKeys === null || knownKeys.has(key))
            .map((key) => ({ key, value: Object.hasOwn(given, key) ? given[key] : null })),
        ...Object.keys(given)
            .filter((k) => !templateKeys.includes(k))
            .map((key) => ({ key, value: given[key] })),
    ];
    try {
        normaliseFieldEntries(fm.kind, fields);
    } catch (err) {
        const refused = err instanceof ValidationError ? (err.details as { fields?: Array<{ key: string; reason: string }> } | undefined)?.fields : undefined;
        if (!refused) throw err;
        for (const r of refused) problems.add({ path, reason: r.reason, key: `fields.${r.key}` });
        ok = false;
    }

    const relations: PreparedElement['relations'] = [];
    (fm.relations ?? []).forEach((r, i) => {
        const note = attempt(`relations.${i}.note`, () => optionalBlock(r.note, RELATION_NOTE_MAX, 'Note') ?? null);
        if (r.to === fm.slug) {
            problems.add({ path, reason: 'SELF_RELATION', key: `relations.${i}` });
            ok = false;
        }
        // Its fields (Phase 3.3), against its type's template when the type is one this kind declares (an unknown type is refused below).
        const fields: FieldEntry[] = Object.entries(r.fields ?? {}).map(([key, value]) => ({ key, value }));
        if (fields.length > 0 && getRelationType(fm.kind, r.type)) {
            try {
                normaliseRelationFieldEntries({ fromKind: fm.kind, type: r.type }, fields);
            } catch (err) {
                const refused = err instanceof ValidationError ? (err.details as { fields?: Array<{ key: string; reason: string }> } | undefined)?.fields : undefined;
                if (!refused) throw err;
                for (const f of refused) problems.add({ path, reason: f.reason, key: `relations.${i}.fields.${f.key}` });
                ok = false;
            }
        }
        if (note !== undefined) relations.push({ type: r.type, to: r.to, note, fields });
    });

    if (!ok || name === undefined || summary === undefined || customLabel === undefined) return null;
    return { path, kind: fm.kind, name, slug: fm.slug, status: fm.status, customLabel, summary, orderRank: fm.order, fields, relations };
}

interface ParsedBundle {
    book: BundleBookFrontmatter | null;
    elements: PreparedElement[];
}

/** Let the event loop serve other requests between two files' parses (Phase 1.H, #27). */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Every entry of the archive classified, parsed and checked; every problem
 * collected. Parsing is CPU-bound (about 1.5 µs a character of dense YAML), so
 * it yields to the event loop after every file: one request's import holds
 * the process for one file's parse at most (`BUNDLE_ZIP_LIMITS.maxEntryBytes`),
 * never for the whole bundle.
 */
async function parseBundle(entries: ReadonlyMap<string, Uint8Array>, wantBook: boolean, problems: Problems): Promise<ParsedBundle> {
    let book: BundleBookFrontmatter | null = null;
    let templateFields: BundleManifest['templateFields'];
    const manifest = entries.get(MANIFEST_FILE);
    if (!manifest) {
        problems.add({ path: MANIFEST_FILE, reason: 'MANIFEST_MISSING' });
    } else {
        let value: unknown;
        try {
            value = JSON.parse(decodeUtf8(manifest));
        } catch {
            value = undefined;
        }
        const parsed = BundleManifest.safeParse(value);
        if (!parsed.success) problems.add({ path: MANIFEST_FILE, reason: 'MANIFEST_INVALID' });
        else if (parsed.data.version !== BUNDLE_VERSION) problems.add({ path: MANIFEST_FILE, reason: 'FORMAT_VERSION_UNSUPPORTED' });
        else templateFields = parsed.data.templateFields;
    }
    const knownKeysOf = (kind: BibleKind): ReadonlySet<string> | null => (templateFields ? new Set(templateFields[kindDirectory(kind)] ?? []) : null);

    const elements: PreparedElement[] = [];
    const slugPaths = new Map<string, string>();
    let elementFiles = 0;
    for (const [path, bytes] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (path === MANIFEST_FILE || isDesktopLitter(path)) continue;
        await yieldToEventLoop();
        if (path === BOOK_FILE) {
            // Read only when it will be applied: book details not asked for are
            // never parsed, so a book.md the import ignores cannot refuse it.
            if (!wantBook) continue;
            const value = frontmatterValue(path, bytes, problems);
            if (value === undefined) continue;
            const parsed = BundleBookFrontmatter.safeParse(value);
            if (!parsed.success) schemaProblems(path, 'BOOK_INVALID', parsed.error.issues, problems);
            else book = parsed.data;
            continue;
        }
        const segments = path.split('/');
        const kind = segments.length === 2 ? kindOfDirectory(segments[0]) : null;
        if (!kind || !segments[1].endsWith('.md')) {
            problems.add({ path, reason: 'UNEXPECTED_ENTRY' });
            continue;
        }
        if (segments[1] === INDEX_FILE) continue; // generated for reading; not imported
        const fileSlug = segments[1].slice(0, -'.md'.length);
        if (!SLUG_PATTERN.test(fileSlug)) {
            problems.add({ path, reason: 'UNEXPECTED_ENTRY' });
            continue;
        }
        elementFiles++;
        if (elementFiles > BUNDLE_MAX_ELEMENTS) {
            problems.add({ path, reason: 'TOO_MANY_ELEMENTS' });
            break;
        }
        const value = frontmatterValue(path, bytes, problems);
        if (value === undefined) continue;
        const parsed = BundleElementFrontmatter.safeParse(value);
        if (!parsed.success) {
            schemaProblems(path, 'ELEMENT_INVALID', parsed.error.issues, problems);
            continue;
        }
        const fm = parsed.data;
        if (fm.kind !== kind) {
            problems.add({ path, reason: 'KIND_MISMATCH', key: 'kind' });
            continue;
        }
        if (fm.slug !== fileSlug) {
            problems.add({ path, reason: 'SLUG_MISMATCH', key: 'slug' });
            continue;
        }
        const other = slugPaths.get(fm.slug);
        if (other) {
            problems.add({ path, reason: 'DUPLICATE_SLUG', key: 'slug' });
            continue;
        }
        slugPaths.set(fm.slug, path);
        const prepared = prepareElement(path, fm, knownKeysOf(fm.kind), problems);
        if (prepared) elements.push(prepared);
    }
    // One element per place in an order, within the bundle.
    const claimed = new Map<string, string>();
    for (const e of elements) {
        if (e.orderRank === undefined) continue;
        const place = `${e.kind}:${e.orderRank}`;
        if (claimed.has(place)) problems.add({ path: e.path, reason: 'ORDER_DUPLICATE', key: 'order' });
        else claimed.set(place, e.path);
    }
    if (elementFiles === 0 && !problems.any) problems.add({ path: '', reason: 'BUNDLE_EMPTY' });
    if (wantBook && book === null && !entries.has(BOOK_FILE)) problems.add({ path: BOOK_FILE, reason: 'BOOK_FILE_MISSING' });
    return { book, elements: sortElements(elements) };
}

export type ImportOutcome = 'created' | 'updated' | 'unchanged';

export interface ImportedElementView {
    id: string;
    kind: BibleKind;
    slug: string;
    name: string;
    outcome: ImportOutcome;
    /** The version this import wrote, or null when it wrote none. */
    versionNumber: number | null;
}

export interface BundleImportReport {
    elements: { created: number; updated: number; unchanged: number };
    /** Versions written, every one with source IMPORT. */
    versionsWritten: number;
    relations: { created: number; updated: number; unchanged: number };
    bookDetailsApplied: boolean;
    items: ImportedElementView[];
}

type ExistingRow = Awaited<ReturnType<typeof BibleElementRepository.findBySlugs>>[number];

/** Elements read per query when looking slugs up. */
const SLUG_LOOKUP_BATCH = 500;

async function existingBySlug(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, slugs: readonly string[]): Promise<Map<string, ExistingRow>> {
    const out = new Map<string, ExistingRow>();
    for (let i = 0; i < slugs.length; i += SLUG_LOOKUP_BATCH) {
        for (const row of await BibleElementRepository.findBySlugs(db, ctx.workspaceId, bookId, slugs.slice(i, i + SLUG_LOOKUP_BATCH))) out.set(row.slug, row);
    }
    return out;
}

/** Ranks asked about in one query (the ORDER_TAKEN check). */
const RANK_LOOKUP_BATCH = 1_000;

/**
 * Check the bundle's ranks against the book's (Phase 3.2), adding
 * `ORDER_TAKEN` for a rank another element keeps; answer the ids of the
 * book's elements whose rank the bundle changes (they vacate their places
 * before any is written).
 */
async function placesFromBundle(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    elements: readonly PreparedElement[],
    existing: ReadonlyMap<string, ExistingRow>,
    problems: Problems,
): Promise<string[]> {
    const reranked: string[] = [];
    for (const kind of ORDERED_KINDS) {
        const given = elements.filter((e) => e.kind === kind && e.orderRank !== undefined);
        if (given.length === 0) continue;
        const moving = new Set(given.flatMap((e) => (existing.get(e.slug) ? [existing.get(e.slug)!.id] : [])));
        // Only the places the bundle names are asked about (Phase 3.H, #50 item 3): a read of the whole order was
        // capped at ORDER_SCOPE_MAX + 1 rows and, past it, could miss a taken place (a unique violation, a 500).
        const ranks = [...new Set(given.map((e) => e.orderRank!))];
        const holders: Array<{ id: string; orderRank: string | null }> = [];
        for (let i = 0; i < ranks.length; i += RANK_LOOKUP_BATCH) holders.push(...(await BibleElementRepository.holdersOfRanks(db, ctx.workspaceId, bookId, kind, ranks.slice(i, i + RANK_LOOKUP_BATCH))));
        const kept = new Set(holders.filter((r) => !moving.has(r.id)).map((r) => r.orderRank as string));
        for (const e of given) if (kept.has(e.orderRank!)) problems.add({ path: e.path, reason: 'ORDER_TAKEN', key: 'order' });
        for (const e of given) {
            const row = existing.get(e.slug);
            if (row && row.orderRank !== null && row.orderRank !== e.orderRank) reranked.push(row.id);
        }
    }
    return reranked;
}

/** Bring one element to its file's state: create it, or change what differs. One version if anything changed. */
async function applyElement(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, p: PreparedElement, existing: ExistingRow | undefined): Promise<ImportedElementView> {
    const base = { kind: p.kind, slug: p.slug, name: p.name };
    if (!existing) {
        const element = await BibleElementRepository.create(db, ctx.workspaceId, bookId, {
            kind: p.kind as BibleElementKind,
            name: p.name,
            slug: p.slug,
            status: p.status,
            summary: p.summary,
            customLabel: p.customLabel,
            orderRank: p.orderRank ?? null,
        });
        await BibleElementRepository.lock(db, element.id);
        await writeFieldValues(db, ctx, element, p.fields);
        const version = await recordVersion(db, ctx, bookId, element.id, { source: 'IMPORT' });
        return { ...base, id: element.id, outcome: 'created', versionNumber: version.versionNumber };
    }
    await BibleElementRepository.lock(db, existing.id);
    // Compared with the element as it stands UNDER its lock, never with the
    // row read before it (Phase 1.H): a save that landed in between would
    // otherwise make a column look already equal to the file, and the import
    // would leave that save's value and report the element unchanged. Deleted
    // in between, the file creates it again.
    const current = await BibleElementRepository.find(db, ctx.workspaceId, bookId, existing.id);
    if (!current) return applyElement(db, ctx, bookId, p, undefined);
    const wanted: ElementWrite = {
        name: p.name,
        status: p.status,
        summary: p.summary,
        customLabel: p.customLabel,
        ...(p.orderRank !== undefined ? { orderRank: p.orderRank } : {}),
    };
    const data: ElementWrite = {};
    for (const k of Object.keys(wanted) as Array<keyof ElementWrite>) {
        if (wanted[k] !== current[k]) Object.assign(data, { [k]: wanted[k] });
    }
    const columnsChanged = Object.keys(data).length > 0;
    if (columnsChanged) await BibleElementRepository.update(db, ctx.workspaceId, bookId, current.id, data);
    const changedKeys = await writeFieldValues(db, ctx, current, p.fields);
    if (!columnsChanged && changedKeys.length === 0) return { ...base, id: current.id, outcome: 'unchanged', versionNumber: null };
    if (!columnsChanged) await BibleElementRepository.touch(db, ctx.workspaceId, bookId, current.id);
    const version = await recordVersion(db, ctx, bookId, current.id, { source: 'IMPORT' });
    return { ...base, id: current.id, outcome: 'updated', versionNumber: version.versionNumber };
}

/** The bundle's book details as the book's write, sanitised by `bookWrite`, keeping only what differs. */
function bookChanges(fm: BundleBookFrontmatter, current: Awaited<ReturnType<typeof requireBook>>): BookWrite {
    const wanted = bookWrite({
        title: fm.title,
        logline: fm.logline ?? null,
        genre: fm.genre ?? null,
        audience: fm.audience ?? null,
        targetLength: fm.targetLength ?? null,
        stage: fm.stage,
    });
    const out: BookWrite = {};
    for (const k of Object.keys(wanted) as Array<keyof BookWrite>) {
        if (wanted[k] !== current[k]) Object.assign(out, { [k]: wanted[k] });
    }
    return out;
}

/**
 * Import a Markdown bundle (the zip's bytes) into the book. Answers a report
 * of what was created, updated and left unchanged; refuses the whole bundle,
 * writing nothing, with every problem found.
 */
export async function importBibleBundle(
    ctx: WorkspaceRequestContext,
    bookId: string,
    bytes: Uint8Array,
    options: unknown = {},
    deps: ImportDeps = {},
): Promise<BundleImportReport> {
    await assertPermission(ctx, 'bible.edit');
    // A book that is not there (or deleted) is a 404 before the upload is read or scanned.
    await runInWorkspaceContext(ctx, (db) => requireBook(db, ctx, bookId));
    const opts = BundleImportOptions.parse(options);
    if (bytes.byteLength === 0) throw new ValidationError('A bundle is required.', { reason: 'BODY_REQUIRED' });
    await assertUploadClean(ctx, bytes, deps, 'bundle');

    const problems = new Problems();
    let entries: ReadonlyMap<string, Uint8Array>;
    try {
        entries = unwrapBundleFolder(readZip(bytes, BUNDLE_ZIP_LIMITS));
    } catch (err) {
        if (!(err instanceof ZipRefusal)) throw err;
        problems.add({ path: err.entry ?? '', reason: err.reason });
        throw problems.refusal();
    }
    const wantBook = opts.bookDetails === 'apply';
    const bundle = await parseBundle(entries, wantBook, problems);
    if (problems.any) throw problems.refusal();

    try {
        return await runInWorkspaceContext(
            ctx,
            async (db) => {
                await BookRepository.lockForImport(db, bookId);
                // The bundle may create and rename elements: the names lock
                // before any element's (its order; issue #39 item 5).
                await BibleElementRepository.lockNames(db, bookId);
                // And it may place elements in a story order: each order's lock
                // before any element's (Phase 3.2), as a move takes it.
                for (const kind of ORDERED_KINDS) {
                    if (bundle.elements.some((e) => e.kind === kind && e.orderRank !== undefined)) await BibleElementRepository.lockOrder(db, bookId, kind);
                }
                const book = await requireBook(db, ctx, bookId);
                const bundleSlugs = new Set(bundle.elements.map((e) => e.slug));
                const targets = new Set(bundle.elements.flatMap((e) => e.relations.map((r) => r.to)));
                const existing = await existingBySlug(db, ctx, bookId, [...new Set([...bundleSlugs, ...targets])]);

                // Checks that need the book: the kind of an element the book
                // already holds, and every relation's target and type.
                const kindOf = new Map<string, BibleKind>([...existing].map(([slug, row]) => [slug, row.kind as BibleKind]));
                for (const e of bundle.elements) {
                    const held = existing.get(e.slug);
                    if (held && held.kind !== e.kind) problems.add({ path: e.path, reason: 'KIND_CONFLICT', key: 'kind' });
                    kindOf.set(e.slug, e.kind);
                }
                // A relation the bundle states twice (the same type to the same
                // target, or a symmetric one from both of its ends) is refused:
                // applied twice, its note would be rewritten on every import,
                // and the one that won would depend on file order.
                const stated = new Set<string>();
                for (const e of bundle.elements) {
                    e.relations.forEach((r, i) => {
                        const targetKind = kindOf.get(r.to);
                        if (!targetKind) problems.add({ path: e.path, reason: 'RELATION_TARGET_UNKNOWN', key: `relations.${i}` });
                        else if (!relationAllowed(e.kind, r.type, targetKind)) problems.add({ path: e.path, reason: 'RELATION_TYPE_NOT_ALLOWED', key: `relations.${i}` });
                        else {
                            const ends = isSymmetric(getRelationType(e.kind, r.type)!) ? [e.slug, r.to].sort() : [e.slug, r.to];
                            const fact = JSON.stringify([r.type, ...ends]);
                            if (stated.has(fact)) problems.add({ path: e.path, reason: 'DUPLICATE_RELATION', key: `relations.${i}` });
                            stated.add(fact);
                        }
                    });
                }
                // Story order (Phase 3.2): a rank the bundle gives must not be
                // another element's — one that keeps its place, because the
                // bundle gives it no rank or it is not in the bundle at all.
                const reranked = await placesFromBundle(db, ctx, bookId, bundle.elements, existing, problems);
                if (problems.any) throw problems.refusal();
                // Vacate first: a bundle that swaps two elements' places would
                // otherwise meet the unique index halfway through.
                for (const id of reranked) {
                    await BibleElementRepository.lock(db, id);
                    await BibleElementRepository.setOrderRank(db, ctx.workspaceId, bookId, id, null);
                }

                const items: ImportedElementView[] = [];
                const idBySlug = new Map<string, string>([...existing].map(([slug, row]) => [slug, row.id]));
                for (const e of bundle.elements) {
                    const item = await applyElement(db, ctx, bookId, e, existing.get(e.slug));
                    idBySlug.set(e.slug, item.id);
                    items.push(item);
                }

                const relations = { created: 0, updated: 0, unchanged: 0 };
                for (const e of bundle.elements) {
                    const from = idBySlug.get(e.slug)!;
                    for (const r of e.relations) {
                        const to = idBySlug.get(r.to)!;
                        const symmetric = isSymmetric(getRelationType(e.kind, r.type)!);
                        const found = symmetric
                            ? await BibleRelationRepository.findPair(db, ctx.workspaceId, bookId, from, to, r.type)
                            : await BibleRelationRepository.findExact(db, ctx.workspaceId, bookId, from, to, r.type);
                        // Phase 3.3 (D24): a relation the import creates or changes (its note, its fields) gets one version, source IMPORT.
                        if (!found) {
                            const created = await BibleRelationRepository.create(db, ctx.workspaceId, bookId, { fromElementId: from, toElementId: to, type: r.type, symmetric, note: r.note });
                            const saved = relationForSave(bookId, { id: created.id, type: r.type, fromElementId: from, toElementId: to, note: r.note, from: { kind: e.kind } });
                            if (r.fields.length > 0) await writeRelationFieldValues(db, ctx, saved, r.fields);
                            await recordRelationVersion(db, ctx, saved, { source: 'IMPORT' });
                            relations.created++;
                        } else {
                            await BibleRelationRepository.lock(db, found.id);
                            const noteChanged = (found.note ?? null) !== r.note;
                            if (noteChanged) await BibleRelationRepository.updateNote(db, ctx.workspaceId, bookId, found.id, r.note);
                            const saved = relationForSave(bookId, { id: found.id, type: r.type, fromElementId: found.fromElementId, toElementId: found.toElementId, note: r.note, from: { kind: found.fromElementId === from ? e.kind : (kindOf.get(r.to) ?? e.kind) } });
                            const fieldsChanged = r.fields.length > 0 ? await writeRelationFieldValues(db, ctx, saved, r.fields) : [];
                            if (noteChanged || fieldsChanged.length > 0) {
                                await recordRelationVersion(db, ctx, saved, { source: 'IMPORT' });
                                relations.updated++;
                            } else {
                                relations.unchanged++;
                            }
                        }
                    }
                }

                let bookDetailsApplied = false;
                if (wantBook && bundle.book) {
                    const changes = bookChanges(bundle.book, book);
                    if (Object.keys(changes).length > 0) {
                        await BookRepository.update(db, ctx.workspaceId, bookId, changes);
                        bookDetailsApplied = true;
                    }
                }

                const count = (o: ImportOutcome) => items.filter((i) => i.outcome === o).length;
                const report: BundleImportReport = {
                    elements: { created: count('created'), updated: count('updated'), unchanged: count('unchanged') },
                    versionsWritten: items.filter((i) => i.versionNumber !== null).length,
                    relations,
                    bookDetailsApplied,
                    items,
                };
                await logEvent(
                    ctx,
                    {
                        action: 'BIBLE_BUNDLE_IMPORTED',
                        entityType: 'Book',
                        entityId: bookId,
                        details: {
                            elementsCreated: report.elements.created,
                            elementsUpdated: report.elements.updated,
                            elementsUnchanged: report.elements.unchanged,
                            versionsWritten: report.versionsWritten,
                            relationsCreated: relations.created,
                            relationsUpdated: relations.updated,
                            bookDetailsApplied,
                            bytes: bytes.byteLength,
                        },
                    },
                    { db },
                );
                return report;
            },
            { timeout: IMPORT_TX_TIMEOUT_MS },
        );
    } catch (err) {
        // A slug another create took between the lookup and the insert.
        if (isUniqueViolation(err)) throw slugConflict();
        throw err;
    }
}

// ─── The concept note ───────────────────────────────────────────────

/** The RESEARCH field a concept note's text is kept in. */
export const CONCEPT_NOTE_FIELD = 'notes';
/** The name of a note whose text gives none. */
const CONCEPT_NOTE_FALLBACK_NAME = 'Concept note';
/** The slug base of a note whose name gives none (a name of no Latin letters or digits). */
const CONCEPT_NOTE_FALLBACK_SLUG = 'concept-note';

export interface ConceptNoteReport {
    element: { id: string; kind: 'RESEARCH'; slug: string; name: string };
    /** Always a new element: a note never updates one (#27 item 3). */
    outcome: 'created';
    versionNumber: number;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain text as rich text: a paragraph per blank-line-separated block, a line break per line. */
export function conceptNoteHtml(text: string): string {
    return text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .map((p) => `<p>${p.split('\n').map(escapeHtml).join('<br />')}</p>`)
        .join('');
}

/** The note's first line, cut at a word to fit a name; the fallback when there is none. */
export function conceptNoteName(text: string): string {
    const first = text.split('\n').find((l) => l.trim() !== '')?.replace(/\s+/g, ' ').trim() ?? '';
    if (first === '') return CONCEPT_NOTE_FALLBACK_NAME;
    if (first.length <= ELEMENT_NAME_MAX) return first;
    const cut = first.slice(0, ELEMENT_NAME_MAX);
    const space = cut.lastIndexOf(' ');
    return (space > ELEMENT_NAME_MAX / 2 ? cut.slice(0, space) : cut).trim();
}

export async function importConceptNote(ctx: WorkspaceRequestContext, bookId: string, input: unknown, deps: ImportDeps = {}): Promise<ConceptNoteReport> {
    await assertPermission(ctx, 'bible.edit');
    // A book that is not there (or deleted) is a 404 before the note is read or scanned.
    await runInWorkspaceContext(ctx, (db) => requireBook(db, ctx, bookId));
    const parsed = ConceptNoteInput.parse(input);
    await assertUploadClean(ctx, new TextEncoder().encode(parsed.text), deps, 'concept-note');

    const text = plainBlock(parsed.text);
    if (text === '') throw new ValidationError('The concept note is empty.', { reason: 'EMPTY', field: 'Text' });
    if (text.length > CONCEPT_NOTE_MAX) throw new ValidationError('The concept note is too long.', { reason: 'TOO_LONG', field: 'Text' });
    const name = parsed.name ? requiredLine(parsed.name, ELEMENT_NAME_MAX, 'Name') : requiredLine(conceptNoteName(text), ELEMENT_NAME_MAX, 'Name');
    const fields: FieldEntry[] = [{ key: CONCEPT_NOTE_FIELD, value: conceptNoteHtml(text) }];
    // Refuse a value the field will not take before anything is written. The
    // only way a sanitised note within CONCEPT_NOTE_MAX can fail is its
    // markup (a `<br />` per line, an entity per `&` or `<`) taking the
    // paragraphs past the rich-text bound: to the author that is a note too
    // long, so it is answered as the note's own TOO_LONG, which the modal
    // words, not as a field-value refusal of a field they never named.
    try {
        normaliseFieldEntries('RESEARCH', fields);
    } catch (err) {
        if (err instanceof ValidationError && reasonOf(err) === 'FIELD_VALUES_REFUSED') {
            throw new ValidationError('The concept note is too long.', { reason: 'TOO_LONG', field: 'Text' });
        }
        throw err;
    }

    // A supplied slug that is taken is the author's to change; a derived one
    // that a concurrent create took between the lookup and the insert is ours
    // to move on from, in a fresh transaction (as `createElement` does).
    const attempts = parsed.slug ? 1 : DERIVED_SLUG_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
        try {
            return await runInWorkspaceContext(ctx, async (db) => {
                await requireBook(db, ctx, bookId);
                await BibleElementRepository.lockNames(db, bookId);
                let slug: string;
                if (parsed.slug) {
                    if (await BibleElementRepository.slugTaken(db, ctx.workspaceId, bookId, parsed.slug)) throw slugConflict();
                    slug = parsed.slug;
                } else {
                    slug = await freeSlug(db, ctx, bookId, slugify(name) || CONCEPT_NOTE_FALLBACK_SLUG);
                }
                const element = await BibleElementRepository.create(db, ctx.workspaceId, bookId, { kind: 'RESEARCH', name, slug });
                await BibleElementRepository.lock(db, element.id);
                await writeFieldValues(db, ctx, element, fields);
                const version = await recordVersion(db, ctx, bookId, element.id, { source: 'IMPORT' });
                const report: ConceptNoteReport = {
                    element: { id: element.id, kind: 'RESEARCH', slug, name },
                    outcome: 'created',
                    versionNumber: version.versionNumber,
                };
                await logEvent(
                    ctx,
                    {
                        action: 'BIBLE_CONCEPT_NOTE_IMPORTED',
                        entityType: 'BibleElement',
                        entityId: element.id,
                        details: { bookId, outcome: report.outcome, versionNumber: report.versionNumber, length: text.length },
                    },
                    { db },
                );
                return report;
            });
        } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            if (attempt >= attempts) throw slugConflict();
        }
    }
}
