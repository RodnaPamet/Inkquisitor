/**
 * WHAT A QUESTION MAY BE ABOUT (Phase 3.3, decision D24). Pure, client-safe.
 *
 * The engine (frontier, plan, round, dedupe, validation) works on SUBJECTS: a
 * list of things with fields, each named by an id. Before 3.3 every subject
 * was a bible element and its id the element's. 3.3 adds two:
 *
 *   a RELATION   its subject id is the relation's id (cuids never collide
 *                with an element's), its fields its type's relation fields
 *                (`relationFieldDefs`), its stored values the relation's
 *                fields. A question about it is stored under the relation's
 *                declaring element with `Question.relationId` set; reading
 *                it back gives the relation's id as the subject.
 *   PENDING      a BETWEEN session's element not yet created ("What happens
 *                between these?"): the subject id `PENDING_SUBJECT_ID`, the
 *                fields of its kind's template, nothing stored, and the slot's
 *                act already answered by the slot itself. A question about it
 *                is stored under the slot's earlier neighbour with
 *                `Question.aboutPending`. Once a round has proposed the beat
 *                (Phase 3.H, D25 as amended), it is still this subject: it
 *                takes the beat's name, and what the beat holds counts as
 *                stored, so later rounds ask about its remaining fields.
 *
 * So a `FieldRef` (`frontier.ts`) addresses a relation field by its relation's
 * id and a pending field by `PENDING_SUBJECT_ID`, and every rule keyed on a
 * subject — "never ask what the bible answers" (rule 5), dependencies, one
 * question per field a round, "a question about another subject is never a
 * repeat" — holds for them unchanged. `subjectIdOf` is the one reading of a
 * stored question's subject.
 */
import type { BibleKind } from '@/lib/bible/kinds';

/** The subject id of a BETWEEN session's element not yet created. Not a cuid, so never an element's or a relation's id. */
export const PENDING_SUBJECT_ID = 'pending-element';

/** A relation as a subject: its type and its two ends (names are author text, sent only as data). */
export interface RelationSubject {
    relationId: string;
    type: string;
    /** The type's label, read from the `from` end (product text). */
    label: string;
    fromElementId: string;
    toElementId: string;
    fromKind: BibleKind;
    toKind: BibleKind;
    fromName: string;
    toName: string;
}

/** The BETWEEN session's element not yet created: its kind, the two neighbours it sits between, and its act lane. */
export interface PendingSubject {
    kind: BibleKind;
    afterElementId: string;
    beforeElementId: string;
    afterName: string;
    beforeName: string;
    /** The act lane the two neighbours share (an option value of the kind's `act` field), or null. */
    act: string | null;
    /**
     * Phase 3.H (D25 as amended): the name of the beat an earlier round of the
     * session proposed for the slot, once it has one (author text, sent only
     * as data). The session goes on asking about that beat's own fields.
     */
    proposedName?: string;
}

/** How a relation subject is named on a page: "A — label — B". */
export function relationSubjectName(r: Pick<RelationSubject, 'fromName' | 'toName' | 'label'>): string {
    return `${r.fromName} — ${r.label} — ${r.toName}`;
}

/**
 * Phase 4.4 (D30): a PAIR — two elements of the session's scope with no relation yet ("What does Wren want from the
 * Harbourmaster?"). Its subject id is `pair:<first>:<second>` (cuids hold no colon, so it is never an element's or a
 * relation's id), its fields the built-in `related_to`'s, nothing stored. A question about it is filed under the first
 * element with `Question.pairElementId` naming the second; its answer may lead reconcile to propose a NEW_RELATION
 * between the two (2.5 / 3.3), which the author accepts or rejects as ever.
 */
export const PAIR_SUBJECT_PREFIX = 'pair:';

export function pairSubjectId(firstElementId: string, secondElementId: string): string {
    return `${PAIR_SUBJECT_PREFIX}${firstElementId}:${secondElementId}`;
}

/** The two elements a pair subject id names, or null for any other subject id. */
export function pairOfSubject(subjectId: string): { firstElementId: string; secondElementId: string } | null {
    if (!subjectId.startsWith(PAIR_SUBJECT_PREFIX)) return null;
    const rest = subjectId.slice(PAIR_SUBJECT_PREFIX.length);
    const at = rest.indexOf(':');
    if (at <= 0 || at === rest.length - 1 || rest.indexOf(':', at + 1) !== -1) return null;
    return { firstElementId: rest.slice(0, at), secondElementId: rest.slice(at + 1) };
}

/** The subject a stored question is about: its relation, the pending element, a pair (Phase 4.4), or its element. */
export function subjectIdOf(q: { elementId: string; relationId: string | null; aboutPending: boolean; pairElementId?: string | null }): string {
    if (q.relationId) return q.relationId;
    if (q.aboutPending) return PENDING_SUBJECT_ID;
    if (q.pairElementId) return pairSubjectId(q.elementId, q.pairElementId);
    return q.elementId;
}
