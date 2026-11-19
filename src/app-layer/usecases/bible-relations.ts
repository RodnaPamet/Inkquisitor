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
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { RELATION_NOTE_MAX, RelationCreateInput } from '@/app-layer/schemas/bible';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { getRelationType, isSymmetric, relationAllowed } from '@/lib/bible/templates';
import { isUniqueViolation, optionalBlock, requireBook } from './bible-common';

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
            const ends = [];
            for (const id of [parsed.fromElementId, parsed.toElementId]) {
                const el = await BibleElementRepository.findInWorkspace(db, ctx.workspaceId, id);
                if (!el) throw new NotFoundError('Element not found.');
                if (el.bookId !== bookId) throw new ValidationError('Both elements must belong to this book.', { reason: 'CROSS_BOOK' });
                ends.push(el);
            }
            const [from, to] = ends;
            if (!relationAllowed(from.kind, parsed.type, to.kind)) {
                throw new ValidationError('That relation type does not link these two kinds of element.', {
                    reason: 'RELATION_TYPE_NOT_ALLOWED',
                    fromKind: from.kind,
                    toKind: to.kind,
                    type: parsed.type,
                });
            }
            const type = getRelationType(from.kind, parsed.type)!;
            const symmetric = isSymmetric(type);
            if (symmetric && (await BibleRelationRepository.findPair(db, ctx.workspaceId, bookId, from.id, to.id, parsed.type))) {
                throw new ConflictError('These two elements are already related that way.', RELATION_EXISTS);
            }
            const created = await BibleRelationRepository.create(db, ctx.workspaceId, bookId, {
                fromElementId: from.id,
                toElementId: to.id,
                type: parsed.type,
                symmetric,
                note,
            });
            await logEvent(
                ctx,
                {
                    action: 'BIBLE_RELATION_CREATED',
                    entityType: 'BibleRelation',
                    entityId: created.id,
                    details: { bookId, fromElementId: from.id, toElementId: to.id, type: parsed.type },
                },
                { db },
            );
            return {
                id: created.id,
                fromElementId: created.fromElementId,
                toElementId: created.toElementId,
                type: created.type,
                label: type.label,
                inverseLabel: type.inverseLabel,
                note: created.note,
            };
        });
    } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictError('These two elements are already related that way.', RELATION_EXISTS);
        throw err;
    }
}

export async function removeRelation(ctx: WorkspaceRequestContext, bookId: string, relationId: string): Promise<{ id: string }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const relation = await BibleRelationRepository.find(db, ctx.workspaceId, bookId, relationId);
        if (!relation) throw new NotFoundError('Relation not found.');
        await BibleRelationRepository.remove(db, ctx.workspaceId, bookId, relationId);
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
