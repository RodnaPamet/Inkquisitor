/**
 * Typed relations between two elements of one book (Phase 1.1).
 *
 * A relation is STORED ONCE, from the element whose kind declares the type to
 * the target, and READ FROM BOTH ENDS: `getElement` shows it on the target
 * too, under the type's inverse label. The type must be one the `from`
 * element's kind declares (`src/lib/bible/templates/<kind>.json`) and list the
 * `to` element's kind among its targets, or the built-in `related_to`, which
 * links any two elements. Refused:
 *
 *   an unknown type, or a target kind the type does not list   400 RELATION_TYPE_NOT_ALLOWED
 *   an element related to itself                               400 SELF_RELATION
 *   two elements of different books                            400 CROSS_BOOK (the database's
 *                                                              composite foreign keys refuse it too)
 *   the same relation twice (for a type that reads the same    409 RELATION_EXISTS
 *   both ways, in either direction)
 *
 * The duplicate check is a read before the insert, so it alone would let two
 * concurrent creations of A→B and B→A of a symmetric type both through. The
 * database holds it: a symmetric relation is stored with `symmetric = true`,
 * and a partial unique index over the unordered pair
 * (`BibleRelation_symmetric_pair_key`) refuses the second; its P2002 is
 * answered 409 RELATION_EXISTS like the read's.
 *
 * Relations are not part of an element's version snapshot (a snapshot is the
 * element and its fields); they are audited. The note is author text,
 * sanitised (`optionalBlock`) and encrypted at rest.
 *
 * RELATION FIELDS (Phase 3.3, decision D24). A relation carries its type's
 * fields (`relationFieldDefs`), saved like an element's: under the relation's
 * lock, against the version the edit is based on, writing one
 * `BibleRelationVersion` (`relation-common.ts`, which says why a relation has
 * a history of its own). Every creation writes its first version, so the
 * history begins where the relation does (a relation from before 3.3 begins
 * at its first save). `createRelationInTx` is the one create path: the API,
 * and the review's acceptance of a NEW_RELATION proposal (whose version is
 * INTERVIEW, naming the answers).
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleRelationRepository, BibleRelationVersionRepository } from '@/app-layer/repositories/bible.repository';
import { CHANGE_SUMMARY_MAX, RELATION_NOTE_MAX, RelationCreateInput, RelationFieldsUpdateInput } from '@/app-layer/schemas/bible';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import type { FieldValue } from '@/lib/bible/field-values';
import type { RelationFieldDef } from '@/lib/bible/template-schema';
import { getRelationType, isSymmetric, relationAllowed, relationFieldDefs } from '@/lib/bible/templates';
import type { BibleVersionSource } from '@/lib/bible/kinds';
import { isForeignKeyViolation, isUniqueViolation, optionalBlock, requireBook, type FieldEntry } from './bible-common';
import {
    assertRelationBaseVersion,
    readRelationFieldValues,
    recordRelationVersion,
    relationForSave,
    requireRelationWithEnds,
    writeRelationFieldValues,
    type RelationForSave,
} from './relation-common';
import { lockMapsForBibleDeletion, recordMapsAfterBibleDeletion } from './story-maps';

export interface CreatedRelationView {
    id: string;
    fromElementId: string;
    toElementId: string;
    type: string;
    label: string;
    inverseLabel: string;
    note: string | null;
}

const RELATION_EXISTS = { reason: 'RELATION_EXISTS' } as const;

export interface RelationCreate {
    fromElementId: string;
    toElementId: string;
    type: string;
    /** Sanitised by the caller (`optionalBlock`). */
    note: string | null;
    /** Its first field values (Phase 3.3), checked against the type's fields here. */
    fields?: readonly FieldEntry[];
}

/**
 * Create a relation inside the caller's transaction: the 1.1 rules (both ends
 * in the book, the type declared by the `from` end's kind for the `to` end's
 * kind, no self relation, a symmetric pair once), its first fields, and its
 * first version (Phase 3.3), then the audit row. A unique violation (the
 * symmetric pair index, or the exact triple) surfaces as P2002 for the caller
 * to answer 409 RELATION_EXISTS (`relationExists`).
 */
export async function createRelationInTx(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    input: RelationCreate,
    meta: { source: BibleVersionSource; sourceAnswerIds?: readonly string[]; changeSummary?: string | null },
): Promise<{ relation: CreatedRelationView; versionId: string; versionNumber: number }> {
    if (input.fromElementId === input.toElementId) {
        throw new ValidationError('An element cannot be related to itself.', { reason: 'SELF_RELATION' });
    }
    const ends = [];
    for (const id of [input.fromElementId, input.toElementId]) {
        const el = await BibleElementRepository.findInWorkspace(db, ctx.workspaceId, id);
        if (!el) throw new NotFoundError('Element not found.');
        if (el.bookId !== bookId) throw new ValidationError('Both elements must belong to this book.', { reason: 'CROSS_BOOK' });
        ends.push(el);
    }
    const [from, to] = ends;
    if (!relationAllowed(from.kind, input.type, to.kind)) {
        throw new ValidationError('That relation type does not link these two kinds of element.', {
            reason: 'RELATION_TYPE_NOT_ALLOWED',
            fromKind: from.kind,
            toKind: to.kind,
            type: input.type,
        });
    }
    const type = getRelationType(from.kind, input.type)!;
    const symmetric = isSymmetric(type);
    if (symmetric && (await BibleRelationRepository.findPair(db, ctx.workspaceId, bookId, from.id, to.id, input.type))) {
        throw relationExists();
    }
    if (!symmetric && (await BibleRelationRepository.findExact(db, ctx.workspaceId, bookId, from.id, to.id, input.type))) {
        throw relationExists();
    }
    const created = await BibleRelationRepository.create(db, ctx.workspaceId, bookId, {
        fromElementId: from.id,
        toElementId: to.id,
        type: input.type,
        symmetric,
        note: input.note,
    });
    const saved: RelationForSave = { id: created.id, bookId, type: created.type, fromElementId: from.id, toElementId: to.id, fromKind: from.kind, note: created.note };
    await BibleRelationRepository.lock(db, created.id);
    if (input.fields && input.fields.length > 0) await writeRelationFieldValues(db, ctx, saved, input.fields);
    const version = await recordRelationVersion(db, ctx, saved, meta);
    await logEvent(
        ctx,
        {
            action: 'BIBLE_RELATION_CREATED',
            entityType: 'BibleRelation',
            entityId: created.id,
            details: { bookId, fromElementId: from.id, toElementId: to.id, type: input.type, source: meta.source, versionNumber: version.versionNumber },
        },
        { db },
    );
    return {
        relation: {
            id: created.id,
            fromElementId: created.fromElementId,
            toElementId: created.toElementId,
            type: created.type,
            label: type.label,
            inverseLabel: type.inverseLabel,
            note: created.note,
        },
        versionId: version.id,
        versionNumber: version.versionNumber,
    };
}

export function relationExists(): ConflictError {
    return new ConflictError('These two elements are already related that way.', RELATION_EXISTS);
}

export async function addRelation(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<CreatedRelationView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = RelationCreateInput.parse(input);
    const note = optionalBlock(parsed.note, RELATION_NOTE_MAX, 'Note') ?? null;
    if (parsed.fromElementId === parsed.toElementId) {
        throw new ValidationError('An element cannot be related to itself.', { reason: 'SELF_RELATION' });
    }
    try {
        return await runInWorkspaceContext(ctx, async (db) => {
            await requireBook(db, ctx, bookId);
            const { relation } = await createRelationInTx(db, ctx, bookId, { fromElementId: parsed.fromElementId, toElementId: parsed.toElementId, type: parsed.type, note }, { source: 'MANUAL' });
            return relation;
        });
    } catch (err) {
        if (isUniqueViolation(err)) throw relationExists();
        throw err;
    }
}

// ─── Relation fields (Phase 3.3, decision D24) ──────────────────────

/** Versions a relation's view lists, newest first. */
export const RELATION_VERSIONS_LISTED = 20;

/** One of a relation's template fields, with its stored value (null: empty). */
export interface RelationFieldView {
    field: RelationFieldDef;
    value: FieldValue | null;
}

export interface RelationView {
    id: string;
    type: string;
    label: string;
    inverseLabel: string;
    symmetric: boolean;
    from: { id: string; name: string; kind: BibleElementKind };
    to: { id: string; name: string; kind: BibleElementKind };
    note: string | null;
    fields: RelationFieldView[];
    /** The relation's latest version; 0 when it has none yet (saved before 3.3). */
    versionNumber: number;
    versions: Array<{ versionNumber: number; source: string; changeSummary: string | null; createdAt: string; fromInterview: boolean }>;
}

async function relationView(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, relationId: string): Promise<RelationView> {
    const r = await requireRelationWithEnds(db, ctx, bookId, relationId);
    const type = getRelationType(r.from.kind, r.type);
    const values = await readRelationFieldValues(db, ctx, r.id);
    const versions = await BibleRelationVersionRepository.list(db, ctx.workspaceId, bookId, r.id, RELATION_VERSIONS_LISTED);
    return {
        id: r.id,
        type: r.type,
        label: type?.label ?? r.type,
        inverseLabel: type?.inverseLabel ?? r.type,
        symmetric: r.symmetric,
        from: { id: r.from.id, name: r.from.name, kind: r.from.kind },
        to: { id: r.to.id, name: r.to.name, kind: r.to.kind },
        note: r.note,
        fields: relationFieldDefs(r.from.kind, r.type).map((f) => ({ field: f, value: values.get(f.key) ?? null })),
        versionNumber: versions[0]?.versionNumber ?? 0,
        versions: versions.map((v) => ({
            versionNumber: v.versionNumber,
            source: v.source,
            changeSummary: v.changeSummary,
            createdAt: v.createdAt.toISOString(),
            fromInterview: v.sourceAnswerIds.length > 0,
        })),
    };
}

/** One relation, read from its declaring end: its ends, its note, its fields and its history (`bible.view`). */
export async function getRelation(ctx: WorkspaceRequestContext, bookId: string, relationId: string): Promise<RelationView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return relationView(db, ctx, bookId, relationId);
    });
}

/**
 * Save some of a relation's fields (`bible.edit`): under the relation's lock,
 * against the version the edit is based on (409 VERSION_CONFLICT otherwise,
 * nothing written), one version when something changed.
 */
export async function saveRelationFields(ctx: WorkspaceRequestContext, bookId: string, relationId: string, input: unknown): Promise<RelationView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = RelationFieldsUpdateInput.parse(input);
    return relationGoneAsNotFound(() => runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await BibleRelationRepository.lock(db, relationId);
        const r = await requireRelationWithEnds(db, ctx, bookId, relationId);
        await assertRelationBaseVersion(db, ctx, r.id, parsed.baseVersion);
        const relation = relationForSave(bookId, r);
        const changed = await writeRelationFieldValues(db, ctx, relation, parsed.fields);
        if (changed.length > 0) {
            const version = await recordRelationVersion(db, ctx, relation, { source: 'MANUAL', changeSummary: optionalBlock(parsed.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null });
            await logEvent(
                ctx,
                { action: 'BIBLE_RELATION_FIELDS_SAVED', entityType: 'BibleRelation', entityId: r.id, details: { bookId, fieldKeys: changed, versionNumber: version.versionNumber } },
                { db },
            );
        }
        return relationView(db, ctx, bookId, relationId);
    }));
}

/**
 * A relation deleted by a transaction that committed while a save of its
 * fields was writing (its own removal, or an end's deletion cascading to it,
 * neither of which takes the relation's lock) surfaces as a foreign-key
 * violation on the field row: the relation is gone, so the save is a 404, as
 * it would have been had the deletion committed first, never a 500.
 */
export async function relationGoneAsNotFound<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (err) {
        if (isForeignKeyViolation(err)) throw new NotFoundError('Relation not found.');
        throw err;
    }
}

export async function removeRelation(ctx: WorkspaceRequestContext, bookId: string, relationId: string): Promise<{ id: string }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        // The book's map locks BEFORE the delete, and a snapshot of each map
        // whose edge went with the relation (decision D20); then the
        // relation's own lock (Phase 3.H, issue #53 item 4), last in the book's
        // lock order (map → names → order → element → relation), so a delete
        // queues behind a save of the relation's fields rather than racing it,
        // and is read under it.
        const maps = await lockMapsForBibleDeletion(db, ctx, bookId);
        await BibleRelationRepository.lock(db, relationId);
        const relation = await BibleRelationRepository.find(db, ctx.workspaceId, bookId, relationId);
        if (!relation) throw new NotFoundError('Relation not found.');
        await BibleRelationRepository.remove(db, ctx.workspaceId, bookId, relationId);
        await recordMapsAfterBibleDeletion(db, ctx, bookId, maps);
        await logEvent(
            ctx,
            {
                action: 'BIBLE_RELATION_DELETED',
                entityType: 'BibleRelation',
                entityId: relationId,
                details: { bookId, fromElementId: relation.fromElementId, toElementId: relation.toElementId, type: relation.type },
            },
            { db },
        );
        return { id: relationId };
    });
}
