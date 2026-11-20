/**
 * What the bible usecases share (Phase 1.1): finding a book or element in the
 * caller's workspace, sanitising plain author text, writing a batch of field
 * values, and recording a version.
 *
 * Not a public usecase module: every function here runs inside a transaction
 * a usecase opened with `runInWorkspaceContext` after asking its permission.
 *
 * THE VERSIONED SAVE. Every save of an element or its fields runs, in ONE
 * transaction:
 *
 *   1. `BibleElementRepository.lock(elementId)` — a transaction-scoped
 *      advisory lock, so two saves of one element queue rather than
 *      interleave;
 *   2. the change itself;
 *   3. `recordVersion` — read the element and every field back (inside the
 *      same transaction, so the snapshot is exactly what was committed),
 *      serialise the snapshot, and append version `latest + 1`.
 *
 * Because the number is read under the lock, concurrent saves take distinct,
 * consecutive numbers; the (elementId, versionNumber) unique index is the
 * backstop. A save that would change nothing writes nothing and records no
 * version.
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import { BibleElementRepository, BibleFieldRepository, BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { decodeFieldValue, encodeFieldValue, normaliseFieldValue, sameFieldValue, type FieldValue, type FieldValueRefusal } from '@/lib/bible/field-values';
import type { BibleVersionSource } from '@/lib/bible/kinds';
import { buildSnapshot, serialiseSnapshot } from '@/lib/bible/snapshot';
import { getFieldDef, getTemplate } from '@/lib/bible/templates';
import { slugCandidates } from '@/lib/bible/slug';
import { plainBlock, plainLine } from '@/lib/bible/text';
import { CHANGE_SUMMARY_MAX, CUSTOM_LABEL_MAX } from '@/app-layer/schemas/bible';

// ─── Lookups ────────────────────────────────────────────────────────

export async function requireBook(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string) {
    const book = await BookRepository.find(db, ctx.workspaceId, bookId);
    if (!book) throw new NotFoundError('Book not found.');
    return book;
}

export async function requireElement(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elementId: string) {
    const element = await BibleElementRepository.find(db, ctx.workspaceId, bookId, elementId);
    if (!element) throw new NotFoundError('Element not found.');
    return element;
}

/** A Prisma unique-constraint violation (P2002), told apart without importing the runtime. */
export function isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

export const SLUG_TAKEN = { reason: 'SLUG_TAKEN' } as const;

export function slugConflict(): ConflictError {
    return new ConflictError('Another element of this book already uses that slug.', SLUG_TAKEN);
}

/** Candidates checked per query when deriving a slug. */
const SLUG_CANDIDATE_BATCH = 50;
/** Batches tried before giving up (2,500 elements of one name in one book). */
const SLUG_CANDIDATE_BATCHES = 50;
/**
 * Attempts at a create whose slug was DERIVED. Two creates of one name read
 * the same free slug and the second insert breaks the unique index; it is
 * retried in a fresh transaction, which reads the slug the first one took and
 * moves on. Each retry is lost to a concurrent create of the same name, so
 * this bounds how many may race at once before one is refused.
 */
export const DERIVED_SLUG_ATTEMPTS = 8;

/** The first free candidate slug for `base` in the book, asked by the candidates themselves. */
export async function freeSlug(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, base: string): Promise<string> {
    for (let batch = 0; batch < SLUG_CANDIDATE_BATCHES; batch++) {
        const candidates = slugCandidates(base, 1 + batch * SLUG_CANDIDATE_BATCH, SLUG_CANDIDATE_BATCH);
        const taken = await BibleElementRepository.slugsTaken(db, ctx.workspaceId, bookId, candidates);
        const free = candidates.find((c) => !taken.has(c));
        if (free) return free;
    }
    throw slugConflict();
}

// ─── Plain text ─────────────────────────────────────────────────────

/** A required one-line value: sanitised, then non-empty and within `max`. */
export function requiredLine(input: string, max: number, what: string): string {
    const value = plainLine(input);
    if (value.length === 0) throw new ValidationError(`${what} is empty.`, { reason: 'EMPTY', field: what });
    if (value.length > max) throw new ValidationError(`${what} is too long.`, { reason: 'TOO_LONG', field: what });
    return value;
}

/** An optional one-line value: `undefined` leaves it, `null` or blank clears it. */
export function optionalLine(input: string | null | undefined, max: number, what: string): string | null | undefined {
    if (input === undefined) return undefined;
    if (input === null) return null;
    const value = plainLine(input);
    if (value.length > max) throw new ValidationError(`${what} is too long.`, { reason: 'TOO_LONG', field: what });
    return value.length === 0 ? null : value;
}

/** An optional multi-line value (paragraphs kept): `undefined` leaves it, `null` or blank clears it. */
export function optionalBlock(input: string | null | undefined, max: number, what: string): string | null | undefined {
    if (input === undefined) return undefined;
    if (input === null) return null;
    const value = plainBlock(input);
    if (value.length > max) throw new ValidationError(`${what} is too long.`, { reason: 'TOO_LONG', field: what });
    return value.length === 0 ? null : value;
}

/** The CUSTOM label rule: required (and sanitised) for CUSTOM, absent for every other kind. */
export function customLabelFor(kind: BibleElementKind, input: string | null | undefined): string | null {
    if (kind !== 'CUSTOM') {
        if (input !== undefined && input !== null && input !== '') {
            throw new ValidationError('Only a custom element carries a label of its own.', { reason: 'CUSTOM_LABEL_NOT_ALLOWED' });
        }
        return null;
    }
    if (input === undefined || input === null) throw new ValidationError('A custom element needs a label.', { reason: 'CUSTOM_LABEL_REQUIRED' });
    return requiredLine(input, CUSTOM_LABEL_MAX, 'Custom label');
}

// ─── Fields ─────────────────────────────────────────────────────────

export interface FieldEntry {
    key: string;
    value: unknown;
}

export interface FieldRefusal {
    key: string;
    reason: FieldValueRefusal | 'UNKNOWN_FIELD' | 'DUPLICATE_FIELD';
}

/**
 * Check a batch of field values against the kind's template WITHOUT writing:
 * every refusal at once, so the author sees them all. Returns the normalised
 * (sanitised) values by key.
 */
export function normaliseFieldEntries(kind: BibleElementKind, entries: readonly FieldEntry[]): Map<string, FieldValue | null> {
    const refusals: FieldRefusal[] = [];
    const out = new Map<string, FieldValue | null>();
    for (const entry of entries) {
        const def = getFieldDef(kind, entry.key);
        if (!def) {
            refusals.push({ key: entry.key, reason: 'UNKNOWN_FIELD' });
            continue;
        }
        if (out.has(entry.key)) {
            refusals.push({ key: entry.key, reason: 'DUPLICATE_FIELD' });
            continue;
        }
        const result = normaliseFieldValue(def, entry.value);
        if (!result.ok) refusals.push({ key: entry.key, reason: result.reason });
        else out.set(entry.key, result.value);
    }
    if (refusals.length > 0) throw new ValidationError('Some field values were refused.', { reason: 'FIELD_VALUES_REFUSED', fields: refusals });
    return out;
}

/** The element's stored fields, decoded, by key. */
export async function readFieldValues(db: PrismaTx, ctx: WorkspaceRequestContext, elementId: string): Promise<Map<string, FieldValue>> {
    const rows = await BibleFieldRepository.listForElement(db, ctx.workspaceId, elementId);
    return new Map(rows.map((r) => [r.key, decodeFieldValue(r.value)]));
}

/**
 * Write a batch of field values (sanitised by `normaliseFieldEntries`): set
 * each changed one, delete each cleared one, leave the rest. Returns the keys
 * that changed.
 */
export async function writeFieldValues(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    element: { id: string; kind: BibleElementKind },
    entries: readonly FieldEntry[],
): Promise<string[]> {
    const next = normaliseFieldEntries(element.kind, entries);
    const current = await readFieldValues(db, ctx, element.id);
    const changed: string[] = [];
    const cleared: string[] = [];
    for (const [key, value] of next) {
        const before = current.get(key) ?? null;
        if (sameFieldValue(before, value)) continue;
        changed.push(key);
        if (value === null) {
            cleared.push(key);
        } else {
            const order = getFieldDef(element.kind, key)?.order ?? 1;
            await BibleFieldRepository.upsert(db, ctx.workspaceId, element.id, { key, value: encodeFieldValue(value), order });
        }
    }
    await BibleFieldRepository.removeKeys(db, ctx.workspaceId, element.id, cleared);
    return changed;
}

/** Every template field of the kind, in template order, with its value (null when empty). */
export function fieldViews(kind: BibleElementKind, values: ReadonlyMap<string, FieldValue>) {
    return getTemplate(kind).fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: f.required,
        order: f.order,
        value: values.get(f.key) ?? null,
    }));
}

// ─── Versions ───────────────────────────────────────────────────────

/**
 * The optimistic check (Phase 1.H): a save names the version its edit is
 * based on, and is refused when the element has moved past it — someone else
 * saved in between, and applying this edit would overwrite theirs unseen.
 * Called UNDER the element's lock (`BibleElementRepository.lock`), so the
 * latest number cannot move between this check and the save's own version.
 * Answered 409 `VERSION_CONFLICT` with the version the element is now at;
 * nothing is written. Every request that saves an element names its base
 * (`BaseVersionInput` is required), so there is no unchecked path.
 */
export async function assertBaseVersion(db: PrismaTx, ctx: WorkspaceRequestContext, elementId: string, baseVersion: number): Promise<void> {
    const currentVersion = await BibleVersionRepository.latestNumber(db, ctx.workspaceId, elementId);
    if (currentVersion !== baseVersion) {
        throw new ConflictError('This element was saved by someone else since your edit began.', { reason: 'VERSION_CONFLICT', currentVersion, baseVersion });
    }
}

export interface VersionMeta {
    source: BibleVersionSource;
    /** The author's words, sanitised here; or the product's own (a restore). */
    changeSummary?: string | null;
    restoredFromVersion?: number | null;
    /**
     * The answers an INTERVIEW version is drawn from (Phase 2.5, rule 1):
     * required, and non-empty, exactly when `source` is INTERVIEW (the
     * database's CHECK `BibleEntryVersion_interview_names_answers` holds the
     * same). Written with the version, never after.
     */
    sourceAnswerIds?: readonly string[];
    /**
     * The research findings a RESEARCH version is drawn from (Phase 2.6, rule
     * 1): required, and non-empty, exactly when `source` is RESEARCH (CHECK
     * `BibleEntryVersion_research_names_findings`); and the research proposal
     * it accepted, if any (a finding kept as a research note names none).
     */
    sourceFindingIds?: readonly string[];
    sourceResearchProposalId?: string | null;
    /** The save moved the element in its story order (Phase 3.2): the history words it from this. */
    movedInOrder?: boolean;
}

/**
 * Append the element's next version: a snapshot of the element and every
 * field as they now stand in this transaction. The caller holds the
 * element's lock (`BibleElementRepository.lock`).
 */
export async function recordVersion(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elementId: string, meta: VersionMeta) {
    const element = await requireElement(db, ctx, bookId, elementId);
    const values = await readFieldValues(db, ctx, elementId);
    const snapshot = buildSnapshot({
        element: {
            kind: element.kind,
            name: element.name,
            slug: element.slug,
            status: element.status,
            summary: element.summary,
            customLabel: element.customLabel,
            orderRank: element.orderRank,
        },
        fields: [...values].map(([key, value]) => ({ key, value, order: getFieldDef(element.kind, key)?.order ?? 0 })),
    });
    const sourceAnswerIds = [...new Set(meta.sourceAnswerIds ?? [])];
    if ((meta.source === 'INTERVIEW') !== (sourceAnswerIds.length > 0)) {
        throw new ValidationError('An interview version names the answers it is drawn from, and only an interview version does.', { reason: 'VERSION_SOURCE_ANSWERS' });
    }
    const sourceFindingIds = [...new Set(meta.sourceFindingIds ?? [])];
    if ((meta.source === 'RESEARCH') !== (sourceFindingIds.length > 0) || (meta.sourceResearchProposalId && meta.source !== 'RESEARCH')) {
        throw new ValidationError('A research version names the findings it is drawn from, and only a research version does.', { reason: 'VERSION_SOURCE_FINDINGS' });
    }
    const versionNumber = (await BibleVersionRepository.latestNumber(db, ctx.workspaceId, elementId)) + 1;
    return BibleVersionRepository.create(db, ctx.workspaceId, {
        bookId,
        elementId,
        versionNumber,
        snapshot: serialiseSnapshot(snapshot),
        changeSummary: optionalBlock(meta.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null,
        source: meta.source,
        restoredFromVersion: meta.restoredFromVersion ?? null,
        authorId: ctx.userId,
        sourceAnswerIds,
        sourceFindingIds,
        sourceResearchProposalId: meta.sourceResearchProposalId ?? null,
        movedInOrder: meta.movedInOrder ?? false,
    });
}
