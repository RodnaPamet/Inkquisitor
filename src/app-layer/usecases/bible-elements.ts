/**
 * Bible elements and their fields: list, read, create, change, change fields,
 * delete (Phase 1.1).
 *
 * Every call asks its permission first (`bible.view` / `bible.edit`, audited
 * on refusal) and runs inside `runInWorkspaceContext`. Every SAVE — creating
 * an element, changing it, changing its fields — is versioned in the same
 * transaction (`bible-common.ts`: lock, change, `recordVersion`), so the
 * history holds exactly one version per save that changed something, and a
 * version is never written for a change that rolled back.
 *
 * Author text is sanitised before it is stored: names and labels by
 * `requiredLine`, the summary by `optionalBlock` (all over
 * `sanitizePlainText`), field values by `normaliseFieldValue` (plain or rich
 * text by the field's type), each checked against the kind's template.
 *
 * A CUSTOM element carries a `customLabel`; no other kind may (the database
 * holds the same rule). An element's kind is fixed at creation. Slugs are
 * unique per book, derived from the name unless given; a derived slug that
 * a concurrent create takes first is retried with the next free suffix, never
 * refused (`DERIVED_SLUG_ATTEMPTS`).
 *
 * CONCURRENT EDITS (Phase 1.H): a change or a fields save names the
 * version its edit is based on (`baseVersion`, required); under the element's lock, a
 * newer version refuses it 409 `VERSION_CONFLICT` (`assertBaseVersion`), so
 * one writer never silently overwrites another's save.
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import {
    BibleElementRepository,
    BibleFieldRepository,
    BibleRelationRepository,
    BibleVersionRepository,
    type ElementListRow,
    type ElementWrite,
} from '@/app-layer/repositories/bible.repository';
import {
    ELEMENT_NAME_MAX,
    ELEMENT_PAGE_DEFAULT,
    ELEMENT_SUMMARY_MAX,
    ElementCreateInput,
    ElementListQuery,
    ElementUpdateInput,
    FieldsUpdateInput,
} from '@/app-layer/schemas/bible';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import { BIBLE_KINDS } from '@/lib/bible/kinds';
import { slugify } from '@/lib/bible/slug';
import { getFieldDef, getRelationType } from '@/lib/bible/templates';
import {
    assertBaseVersion,
    DERIVED_SLUG_ATTEMPTS,
    fieldViews,
    freeSlug,
    customLabelFor,
    isUniqueViolation,
    normaliseFieldEntries,
    optionalBlock,
    readFieldValues,
    recordVersion,
    requireBook,
    requireElement,
    requiredLine,
    slugConflict,
    writeFieldValues,
    type VersionMeta,
} from './bible-common';
import { lockMapsForBibleDeletion, recordMapsAfterBibleDeletion } from './story-maps';

// ─── Views ──────────────────────────────────────────────────────────

export interface ElementSummaryView {
    id: string;
    bookId: string;
    kind: BibleElementKind;
    name: string;
    slug: string;
    status: string;
    customLabel: string | null;
    summary: string | null;
    updatedAt: string;
}

type ElementRow = NonNullable<Awaited<ReturnType<typeof BibleElementRepository.find>>>;

function summaryView(e: ElementRow): ElementSummaryView {
    return {
        id: e.id,
        bookId: e.bookId,
        kind: e.kind,
        name: e.name,
        slug: e.slug,
        status: e.status,
        customLabel: e.customLabel,
        summary: e.summary,
        updatedAt: e.updatedAt.toISOString(),
    };
}

/** An element as a list shows it (no summary: a list decrypts nothing). */
export interface ElementListItemView extends Omit<ElementSummaryView, 'summary'> {
    /**
     * How many of the kind's template fields hold a value (the book board's
     * completeness, Phase 1.2). A stored key the template no longer has is
     * not counted.
     */
    filledFieldCount: number;
}

/** Stored field rows read per element when counting (a template has at most a few dozen fields). */
const FIELD_KEYS_PER_ELEMENT = 200;

export interface RelationView {
    id: string;
    /** `outgoing`: this element started it (read with `label`); `incoming`: it ends here (read with the inverse label). */
    direction: 'outgoing' | 'incoming';
    type: string;
    label: string;
    other: { id: string; kind: BibleElementKind; name: string; slug: string };
    note: string | null;
}

export interface ElementView extends ElementSummaryView {
    fields: ReturnType<typeof fieldViews>;
    /** Its relations, oldest first, at most `RELATIONS_SHOWN_MAX`. */
    relations: RelationView[];
    /** True when the element has more relations than `relations` holds (rule 6's sibling: a cut list says so). */
    relationsTruncated: boolean;
    /** The latest version's number (0 never happens: creation writes version 1). */
    versionNumber: number;
}

/** Relations an element view carries at most; it reads one more to know when it is cut. */
export const RELATIONS_SHOWN_MAX = 1_000;

async function elementView(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elementId: string): Promise<ElementView> {
    const element = await requireElement(db, ctx, bookId, elementId);
    const values = await readFieldValues(db, ctx, elementId);
    const read = await BibleRelationRepository.listForElement(db, ctx.workspaceId, bookId, elementId, RELATIONS_SHOWN_MAX + 1);
    const relations = read.slice(0, RELATIONS_SHOWN_MAX);
    const versionNumber = await BibleVersionRepository.latestNumber(db, ctx.workspaceId, elementId);
    return {
        ...summaryView(element),
        fields: fieldViews(element.kind, values),
        relationsTruncated: read.length > RELATIONS_SHOWN_MAX,
        relations: relations.map((r) => {
            const outgoing = r.fromElementId === elementId;
            const type = getRelationType(r.from.kind, r.type);
            const other = outgoing ? r.to : r.from;
            return {
                id: r.id,
                direction: outgoing ? 'outgoing' : 'incoming',
                type: r.type,
                label: type ? (outgoing ? type.label : type.inverseLabel) : r.type,
                other: { id: other.id, kind: other.kind, name: other.name, slug: other.slug },
                note: r.note,
            };
        }),
        versionNumber,
    };
}

// ─── Reads ──────────────────────────────────────────────────────────

function listItemView(r: ElementListRow, filled: ReadonlyMap<string, number>): ElementListItemView {
    return {
        id: r.id,
        bookId: r.bookId,
        kind: r.kind,
        name: r.name,
        slug: r.slug,
        status: r.status,
        customLabel: r.customLabel,
        updatedAt: (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString(),
        filledFieldCount: filled.get(r.id) ?? 0,
    };
}

/** A page cursor: the last row's name and id, opaque to the client. */
function encodeCursor(row: { name: string; id: string }): string {
    return Buffer.from(JSON.stringify([row.name, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { name: string; id: string } {
    try {
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string') return { name: value[0], id: value[1] };
    } catch {
        // fall through
    }
    throw new ValidationError('That page cursor is not one this list gave.', { reason: 'CURSOR_INVALID' });
}

/** Each element's count of filled template fields (stored keys its kind's template has; nothing decrypted). */
async function filledCounts(db: PrismaTx, ctx: WorkspaceRequestContext, rows: ReadonlyArray<{ id: string; kind: BibleElementKind }>): Promise<Map<string, number>> {
    const keys = await BibleFieldRepository.keysForElements(
        db,
        ctx.workspaceId,
        rows.map((r) => r.id),
        FIELD_KEYS_PER_ELEMENT,
    );
    const kindOf = new Map(rows.map((r) => [r.id, r.kind] as const));
    const filled = new Map<string, number>();
    for (const { elementId, key } of keys) {
        const elementKind = kindOf.get(elementId);
        if (elementKind && getFieldDef(elementKind, key)) filled.set(elementId, (filled.get(elementId) ?? 0) + 1);
    }
    return filled;
}

async function elementPage(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    options: { kinds?: readonly BibleElementKind[]; q?: string; after?: { name: string; id: string }; take: number },
): Promise<ElementPageView> {
    const rows = await BibleElementRepository.page(db, ctx.workspaceId, bookId, { ...options, take: options.take + 1 });
    const shown = rows.slice(0, options.take);
    const filled = await filledCounts(db, ctx, shown);
    return {
        elements: shown.map((r) => listItemView(r, filled)),
        nextCursor: rows.length > options.take ? encodeCursor(shown[shown.length - 1]) : null,
    };
}

export interface ElementPageView {
    elements: ElementListItemView[];
    /** Pass as `after` for the next page; null when this page is the last. */
    nextCursor: string | null;
}

/**
 * One page of the book's elements, by name (Phase 1.H, #18: the list used to
 * stop silently at 500). Filtered by one kind (`kind`, the board's "show
 * more") or several (`kinds`, the relation picker) and by a name fragment
 * (`q`); `after` is the previous page's `nextCursor`.
 */
export async function listElements(ctx: WorkspaceRequestContext, bookId: string, query: unknown = {}): Promise<ElementPageView> {
    await assertPermission(ctx, 'bible.view');
    const parsed = ElementListQuery.parse(query);
    const kinds = parsed.kinds ?? (parsed.kind ? [parsed.kind] : undefined);
    const q = parsed.q?.trim() || undefined;
    const after = parsed.after ? decodeCursor(parsed.after) : undefined;
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return elementPage(db, ctx, bookId, { kinds, q, after, take: parsed.take ?? ELEMENT_PAGE_DEFAULT });
    });
}

/** Entries the board shows per kind before "show more" (Phase 1.H). */
export const BOARD_ENTRIES_PER_KIND = 25;

export interface BoardKindView {
    kind: BibleElementKind;
    /** Every element of the kind the book holds (an aggregate, not the length of `entries`). */
    entryCount: number;
    /** Filled template fields over every element of the kind (an aggregate). */
    filledFieldCount: number;
    /** The first `BOARD_ENTRIES_PER_KIND` by name. */
    entries: ElementListItemView[];
    /** The next page of this kind (`listElements` with `kind` and `after`), or null. */
    nextCursor: string | null;
}

/**
 * A book's board (Phase 1.H, #18): per kind, how many entries and how many
 * filled fields — both aggregates in the database, so the board is right for
 * a book of any size — and the first page of entries.
 */
export async function getBookBoard(ctx: WorkspaceRequestContext, bookId: string): Promise<BoardKindView[]> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const counts = await BibleElementRepository.countByKind(db, ctx.workspaceId, bookId);
        const filled = new Map<BibleElementKind, number>();
        for (const { kind, key, n } of await BibleFieldRepository.filledKeysByKind(db, ctx.workspaceId, bookId)) {
            if (getFieldDef(kind, key)) filled.set(kind, (filled.get(kind) ?? 0) + n);
        }
        // The first page of every kind in one query, and their filled counts in one more.
        const first = await BibleElementRepository.firstPerKind(db, ctx.workspaceId, bookId, BOARD_ENTRIES_PER_KIND);
        const filledById = await filledCounts(db, ctx, first);
        return BIBLE_KINDS.map((kind) => {
            const entryCount = counts.get(kind) ?? 0;
            const shown = first.filter((r) => r.kind === kind);
            return {
                kind,
                entryCount,
                filledFieldCount: filled.get(kind) ?? 0,
                entries: shown.map((r) => listItemView(r, filledById)),
                nextCursor: entryCount > shown.length && shown.length > 0 ? encodeCursor(shown[shown.length - 1]) : null,
            };
        });
    });
}

export async function getElement(ctx: WorkspaceRequestContext, bookId: string, elementId: string): Promise<ElementView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, (db) => elementView(db, ctx, bookId, elementId));
}

// ─── Writes ─────────────────────────────────────────────────────────

/** What `createElementInTx` creates: already sanitised by its caller (name, summary, label), the fields as the API takes them. */
export interface ElementCreateData {
    kind: BibleElementKind;
    name: string;
    /** A slug the author chose (refused 409 when taken), or none to derive one from the name. */
    slug?: string | null;
    status?: ElementWrite['status'];
    summary: string | null;
    customLabel: string | null;
    fields: readonly { key: string; value: unknown }[];
}

/**
 * THE CREATE PATH (Phase 1.1), in the caller's transaction: the slug (derived,
 * or the author's, refused when taken), the element, its fields, and its
 * first version under the element's lock, audited. Shared by `createElement`
 * and the acceptance of a proposed new element (Phase 2.5, whose version is
 * INTERVIEW and names the answers). Throws a unique violation when a derived
 * slug is lost to a concurrent create: the caller retries in a fresh
 * transaction (`DERIVED_SLUG_ATTEMPTS`).
 */
export async function createElementInTx(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, data: ElementCreateData, meta: VersionMeta) {
    await requireBook(db, ctx, bookId);
    // A new name: after every name check of a concurrent accept, or before it.
    await BibleElementRepository.lockNames(db, bookId);
    let slug: string;
    if (data.slug) {
        if (await BibleElementRepository.slugTaken(db, ctx.workspaceId, bookId, data.slug)) throw slugConflict();
        slug = data.slug;
    } else {
        slug = await freeSlug(db, ctx, bookId, slugify(data.name) || data.kind.toLowerCase().replace(/_/g, '-'));
    }
    const element = await BibleElementRepository.create(db, ctx.workspaceId, bookId, {
        kind: data.kind,
        name: data.name,
        slug,
        status: data.status,
        summary: optionalBlock(data.summary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null,
        customLabel: data.customLabel,
    });
    await BibleElementRepository.lock(db, element.id);
    const changed = await writeFieldValues(db, ctx, element, data.fields);
    const version = await recordVersion(db, ctx, bookId, element.id, meta);
    await logEvent(
        ctx,
        {
            action: 'BIBLE_ELEMENT_CREATED',
            entityType: 'BibleElement',
            entityId: element.id,
            details: { bookId, kind: data.kind, fieldCount: changed.length, versionNumber: version.versionNumber, source: meta.source },
        },
        { db },
    );
    return { element, version };
}

export async function createElement(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<ElementView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = ElementCreateInput.parse(input);
    const name = requiredLine(parsed.name, ELEMENT_NAME_MAX, 'Name');
    const customLabel = customLabelFor(parsed.kind, parsed.customLabel);
    const summary = optionalBlock(parsed.summary, ELEMENT_SUMMARY_MAX, 'Summary') ?? null;
    const entries = parsed.fields ?? [];
    // Refuse bad field values before anything is written.
    normaliseFieldEntries(parsed.kind, entries);
    const attempts = parsed.slug ? 1 : DERIVED_SLUG_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
        try {
            return await runInWorkspaceContext(ctx, async (db) => {
                const { element } = await createElementInTx(
                    db,
                    ctx,
                    bookId,
                    { kind: parsed.kind, name, slug: parsed.slug, status: parsed.status, summary, customLabel, fields: entries },
                    { source: 'MANUAL', changeSummary: parsed.changeSummary ?? null },
                );
                return elementView(db, ctx, bookId, element.id);
            });
        } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            // A supplied slug someone else holds is the author's to change; a
            // derived one is ours to move on from.
            if (attempt >= attempts) throw slugConflict();
        }
    }
}

export async function updateElement(ctx: WorkspaceRequestContext, bookId: string, elementId: string, input: unknown): Promise<ElementView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = ElementUpdateInput.parse(input);
    try {
        return await runInWorkspaceContext(ctx, async (db) => {
            // A rename gives the book a name: the names lock first (its order).
            if (parsed.name !== undefined) await BibleElementRepository.lockNames(db, bookId);
            await BibleElementRepository.lock(db, elementId);
            const element = await requireElement(db, ctx, bookId, elementId);
            await assertBaseVersion(db, ctx, elementId, parsed.baseVersion);
            const data: ElementWrite = {};
            if (parsed.name !== undefined) data.name = requiredLine(parsed.name, ELEMENT_NAME_MAX, 'Name');
            if (parsed.status !== undefined) data.status = parsed.status;
            if (parsed.summary !== undefined) data.summary = optionalBlock(parsed.summary, ELEMENT_SUMMARY_MAX, 'Summary');
            if (parsed.customLabel !== undefined) data.customLabel = customLabelFor(element.kind, parsed.customLabel);
            if (parsed.slug !== undefined && parsed.slug !== element.slug) {
                if (await BibleElementRepository.slugTaken(db, ctx.workspaceId, bookId, parsed.slug, elementId)) throw slugConflict();
                data.slug = parsed.slug;
            }
            const changed = (Object.keys(data) as Array<keyof ElementWrite>).filter((k) => data[k] !== element[k]);
            if (changed.length === 0) return elementView(db, ctx, bookId, elementId);
            await BibleElementRepository.update(db, ctx.workspaceId, bookId, elementId, data);
            const version = await recordVersion(db, ctx, bookId, elementId, { source: 'MANUAL', changeSummary: parsed.changeSummary ?? null });
            await logEvent(
                ctx,
                {
                    action: 'BIBLE_ELEMENT_UPDATED',
                    entityType: 'BibleElement',
                    entityId: elementId,
                    details: { bookId, changed: changed.sort(), versionNumber: version.versionNumber },
                },
                { db },
            );
            return elementView(db, ctx, bookId, elementId);
        });
    } catch (err) {
        if (isUniqueViolation(err)) throw slugConflict();
        throw err;
    }
}

export interface FieldsSaveResult extends ElementView {
    /** Keys whose value changed; empty when the save changed nothing (and so wrote no version). */
    changedKeys: string[];
}

export async function updateElementFields(ctx: WorkspaceRequestContext, bookId: string, elementId: string, input: unknown): Promise<FieldsSaveResult> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = FieldsUpdateInput.parse(input);
    return runInWorkspaceContext(ctx, async (db) => {
        await BibleElementRepository.lock(db, elementId);
        const element = await requireElement(db, ctx, bookId, elementId);
        await assertBaseVersion(db, ctx, elementId, parsed.baseVersion);
        const changedKeys = await writeFieldValues(db, ctx, element, parsed.fields);
        if (changedKeys.length > 0) {
            await BibleElementRepository.touch(db, ctx.workspaceId, bookId, elementId);
            const version = await recordVersion(db, ctx, bookId, elementId, { source: 'MANUAL', changeSummary: parsed.changeSummary ?? null });
            await logEvent(
                ctx,
                {
                    action: 'BIBLE_FIELDS_UPDATED',
                    entityType: 'BibleElement',
                    entityId: elementId,
                    details: { bookId, changedFieldCount: changedKeys.length, versionNumber: version.versionNumber },
                },
                { db },
            );
        }
        return { ...(await elementView(db, ctx, bookId, elementId)), changedKeys };
    });
}

export async function deleteElement(ctx: WorkspaceRequestContext, bookId: string, elementId: string): Promise<{ id: string }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await BibleElementRepository.lock(db, elementId);
        const element = await requireElement(db, ctx, bookId, elementId);
        // The book's map locks BEFORE the delete: its cascade takes the
        // element's nodes and edges off the maps, and each map it moves gets
        // its snapshot (decision D20).
        const maps = await lockMapsForBibleDeletion(db, ctx, bookId);
        if ((await BibleElementRepository.remove(db, ctx.workspaceId, bookId, elementId)) === 0) throw new NotFoundError('Element not found.');
        await recordMapsAfterBibleDeletion(db, ctx, bookId, maps);
        await logEvent(ctx, { action: 'BIBLE_ELEMENT_DELETED', entityType: 'BibleElement', entityId: elementId, details: { bookId, kind: element.kind } }, { db });
        return { id: elementId };
    });
}
