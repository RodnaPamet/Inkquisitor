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
 * unique per book, derived from the name unless given.
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleRelationRepository, BibleVersionRepository, type ElementWrite } from '@/app-layer/repositories/bible.repository';
import {
    CUSTOM_LABEL_MAX,
    ELEMENT_NAME_MAX,
    ELEMENT_SUMMARY_MAX,
    ElementCreateInput,
    ElementListQuery,
    ElementUpdateInput,
    FieldsUpdateInput,
} from '@/app-layer/schemas/bible';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import { firstFreeSlug, slugify } from '@/lib/bible/slug';
import { getRelationType } from '@/lib/bible/templates';
import {
    fieldViews,
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
} from './bible-common';

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
    relations: RelationView[];
    /** The latest version's number (0 never happens: creation writes version 1). */
    versionNumber: number;
}

async function elementView(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elementId: string): Promise<ElementView> {
    const element = await requireElement(db, ctx, bookId, elementId);
    const values = await readFieldValues(db, ctx, elementId);
    const relations = await BibleRelationRepository.listForElement(db, ctx.workspaceId, bookId, elementId);
    const versionNumber = await BibleVersionRepository.latestNumber(db, ctx.workspaceId, elementId);
    return {
        ...summaryView(element),
        fields: fieldViews(element.kind, values),
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

export async function listElements(ctx: WorkspaceRequestContext, bookId: string, query: unknown = {}): Promise<ElementSummaryView[]> {
    await assertPermission(ctx, 'bible.view');
    const { kind } = ElementListQuery.parse(query);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const rows = await BibleElementRepository.list(db, ctx.workspaceId, bookId, { kind });
        return rows.map(summaryView);
    });
}

export async function getElement(ctx: WorkspaceRequestContext, bookId: string, elementId: string): Promise<ElementView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, (db) => elementView(db, ctx, bookId, elementId));
}

// ─── Writes ─────────────────────────────────────────────────────────

/** The CUSTOM label rule: required (and sanitised) for CUSTOM, absent for every other kind. */
function customLabelFor(kind: BibleElementKind, input: string | null | undefined): string | null {
    if (kind !== 'CUSTOM') {
        if (input !== undefined && input !== null && input !== '') {
            throw new ValidationError('Only a custom element carries a label of its own.', { reason: 'CUSTOM_LABEL_NOT_ALLOWED' });
        }
        return null;
    }
    if (input === undefined || input === null) throw new ValidationError('A custom element needs a label.', { reason: 'CUSTOM_LABEL_REQUIRED' });
    return requiredLine(input, CUSTOM_LABEL_MAX, 'Custom label');
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
    try {
        return await runInWorkspaceContext(ctx, async (db) => {
            await requireBook(db, ctx, bookId);
            let slug: string;
            if (parsed.slug) {
                if (await BibleElementRepository.slugTaken(db, ctx.workspaceId, bookId, parsed.slug)) throw slugConflict();
                slug = parsed.slug;
            } else {
                const base = slugify(name) || parsed.kind.toLowerCase().replace(/_/g, '-');
                slug = firstFreeSlug(base, await BibleElementRepository.slugsLike(db, ctx.workspaceId, bookId, base));
            }
            const element = await BibleElementRepository.create(db, ctx.workspaceId, bookId, {
                kind: parsed.kind,
                name,
                slug,
                status: parsed.status,
                summary,
                customLabel,
            });
            await BibleElementRepository.lock(db, element.id);
            const changed = await writeFieldValues(db, ctx, element, entries);
            const version = await recordVersion(db, ctx, bookId, element.id, { source: 'MANUAL', changeSummary: parsed.changeSummary ?? null });
            await logEvent(
                ctx,
                {
                    action: 'BIBLE_ELEMENT_CREATED',
                    entityType: 'BibleElement',
                    entityId: element.id,
                    details: { bookId, kind: parsed.kind, fieldCount: changed.length, versionNumber: version.versionNumber },
                },
                { db },
            );
            return elementView(db, ctx, bookId, element.id);
        });
    } catch (err) {
        if (isUniqueViolation(err)) throw slugConflict();
        throw err;
    }
}

export async function updateElement(ctx: WorkspaceRequestContext, bookId: string, elementId: string, input: unknown): Promise<ElementView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = ElementUpdateInput.parse(input);
    try {
        return await runInWorkspaceContext(ctx, async (db) => {
            await BibleElementRepository.lock(db, elementId);
            const element = await requireElement(db, ctx, bookId, elementId);
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
        if ((await BibleElementRepository.remove(db, ctx.workspaceId, bookId, elementId)) === 0) throw new NotFoundError('Element not found.');
        await logEvent(ctx, { action: 'BIBLE_ELEMENT_DELETED', entityType: 'BibleElement', entityId: elementId, details: { bookId, kind: element.kind } }, { db });
        return { id: elementId };
    });
}
