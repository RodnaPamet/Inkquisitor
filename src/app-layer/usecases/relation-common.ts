/**
 * A relation's versioned save (Phase 3.3, decision D24), shared by the
 * relation usecases and the review's acceptance of a relation proposal. Not a
 * public usecase module: every function here runs inside a transaction a
 * usecase opened with `runInWorkspaceContext` after asking its permission.
 *
 * WHY A RELATION HAS ITS OWN HISTORY. A relation is one fact read from both
 * ends; tying its fields to the declaring element's versions would move that
 * element's version (and refuse its open editor's next save) for a change the
 * other end's page shows, make an element's restore rewrite a relation, and
 * leave a relation's history nowhere once its declaring element is renamed
 * or its relation deleted. So, as an element:
 *
 *   1. `BibleRelationRepository.lock(relationId)` — a transaction-scoped
 *      advisory lock, so two saves of one relation queue;
 *   2. the change itself (its fields, normalised against the TYPE's fields);
 *   3. `recordRelationVersion` — read the relation and every field back in the
 *      same transaction, serialise the snapshot, append version `latest + 1`
 *      (`BibleRelationVersion`, append-only by trigger, keyed to the book so
 *      it outlives the relation).
 *
 * A save names the version it is based on (`assertRelationBaseVersion`, 409
 * VERSION_CONFLICT under the lock); 0 is a relation saved before 3.3. A save
 * that changes nothing writes nothing. An INTERVIEW version names the answers
 * it is drawn from (rule 1; the CHECK holds the same).
 */
import type { BibleElementKind, BibleVersionSource } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BibleRelationFieldRepository, BibleRelationRepository, BibleRelationVersionRepository } from '@/app-layer/repositories/bible.repository';
import { CHANGE_SUMMARY_MAX } from '@/app-layer/schemas/bible';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { decodeFieldValue, encodeFieldValue, normaliseFieldValue, sameFieldValue, type FieldValue } from '@/lib/bible/field-values';
import { buildRelationSnapshot, serialiseRelationSnapshot } from '@/lib/bible/relation-snapshot';
import { getRelationFieldDef } from '@/lib/bible/templates';
import type { FieldEntry, FieldRefusal } from './bible-common';
import { optionalBlock } from './bible-common';

/** A relation as its save reads it: the type and the declaring end's kind decide its fields. */
export interface RelationForSave {
    id: string;
    bookId: string;
    type: string;
    fromElementId: string;
    toElementId: string;
    fromKind: BibleElementKind;
    note: string | null;
}

export async function requireRelationWithEnds(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, relationId: string) {
    const relation = await BibleRelationRepository.findWithEnds(db, ctx.workspaceId, bookId, relationId);
    if (!relation) throw new NotFoundError('Relation not found.');
    return relation;
}

export function relationForSave(bookId: string, r: { id: string; type: string; fromElementId: string; toElementId: string; note: string | null; from: { kind: BibleElementKind } }): RelationForSave {
    return { id: r.id, bookId, type: r.type, fromElementId: r.fromElementId, toElementId: r.toElementId, fromKind: r.from.kind, note: r.note };
}

/** Check a batch of relation field values against the type's fields WITHOUT writing: every refusal at once. */
export function normaliseRelationFieldEntries(relation: Pick<RelationForSave, 'fromKind' | 'type'>, entries: readonly FieldEntry[]): Map<string, FieldValue | null> {
    const refusals: FieldRefusal[] = [];
    const out = new Map<string, FieldValue | null>();
    for (const entry of entries) {
        const def = getRelationFieldDef(relation.fromKind, relation.type, entry.key);
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

/** The relation's stored fields, decoded, by key. */
export async function readRelationFieldValues(db: PrismaTx, ctx: WorkspaceRequestContext, relationId: string): Promise<Map<string, FieldValue>> {
    const rows = await BibleRelationFieldRepository.listForRelation(db, ctx.workspaceId, relationId);
    return new Map(rows.map((r) => [r.key, decodeFieldValue(r.value)]));
}

/** Write a batch of relation field values (sanitised by `normaliseRelationFieldEntries`); returns the keys that changed. */
export async function writeRelationFieldValues(db: PrismaTx, ctx: WorkspaceRequestContext, relation: RelationForSave, entries: readonly FieldEntry[]): Promise<string[]> {
    const next = normaliseRelationFieldEntries(relation, entries);
    const current = await readRelationFieldValues(db, ctx, relation.id);
    const changed: string[] = [];
    const cleared: string[] = [];
    for (const [key, value] of next) {
        if (sameFieldValue(current.get(key) ?? null, value)) continue;
        changed.push(key);
        if (value === null) cleared.push(key);
        else {
            const order = getRelationFieldDef(relation.fromKind, relation.type, key)?.order ?? 1;
            await BibleRelationFieldRepository.upsert(db, ctx.workspaceId, relation.id, { key, value: encodeFieldValue(value), order });
        }
    }
    await BibleRelationFieldRepository.removeKeys(db, ctx.workspaceId, relation.id, cleared);
    return changed;
}

/** The optimistic check (1.H's, for a relation): under the relation's lock, a newer version refuses the save. */
export async function assertRelationBaseVersion(db: PrismaTx, ctx: WorkspaceRequestContext, relationId: string, baseVersion: number): Promise<void> {
    const currentVersion = await BibleRelationVersionRepository.latestNumber(db, ctx.workspaceId, relationId);
    if (currentVersion !== baseVersion) {
        throw new ConflictError('This relation was saved by someone else since your edit began.', { reason: 'VERSION_CONFLICT', currentVersion, baseVersion });
    }
}

export interface RelationVersionMeta {
    source: BibleVersionSource;
    changeSummary?: string | null;
    /** The answers an INTERVIEW version is drawn from: non-empty exactly then (rule 1). */
    sourceAnswerIds?: readonly string[];
}

/** Append the relation's next version: a snapshot of it as it now stands in this transaction. The caller holds its lock. */
export async function recordRelationVersion(db: PrismaTx, ctx: WorkspaceRequestContext, relation: RelationForSave, meta: RelationVersionMeta) {
    const row = await BibleRelationRepository.find(db, ctx.workspaceId, relation.bookId, relation.id);
    if (!row) throw new NotFoundError('Relation not found.');
    const values = await readRelationFieldValues(db, ctx, relation.id);
    const snapshot = buildRelationSnapshot({
        relation: { type: row.type, fromElementId: row.fromElementId, toElementId: row.toElementId, note: row.note },
        fields: [...values].map(([key, value]) => ({ key, value, order: getRelationFieldDef(relation.fromKind, relation.type, key)?.order ?? 0 })),
    });
    const sourceAnswerIds = [...new Set(meta.sourceAnswerIds ?? [])];
    if ((meta.source === 'INTERVIEW') !== (sourceAnswerIds.length > 0) || meta.source === 'RESEARCH') {
        throw new ValidationError('An interview version names the answers it is drawn from, and only an interview version does.', { reason: 'VERSION_SOURCE_ANSWERS' });
    }
    const versionNumber = (await BibleRelationVersionRepository.latestNumber(db, ctx.workspaceId, relation.id)) + 1;
    return BibleRelationVersionRepository.create(db, ctx.workspaceId, {
        bookId: relation.bookId,
        relationId: relation.id,
        versionNumber,
        snapshot: serialiseRelationSnapshot(snapshot),
        changeSummary: optionalBlock(meta.changeSummary, CHANGE_SUMMARY_MAX, 'Change summary') ?? null,
        source: meta.source,
        authorId: ctx.userId,
        sourceAnswerIds,
    });
}
