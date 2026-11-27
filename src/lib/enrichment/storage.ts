/**
 * A proposal on its way into the database (Phase 2.5), sanitised as author
 * text once more, whatever produced it: a proposal's value is model output
 * built from the author's answers, and a new element's name and summary are
 * the author's words. `validate.ts` has already normalised the value; this is
 * the write path's own guarantee (the encrypted-field sanitiser guard holds
 * every writer of the three columns to it).
 *
 *   proposedValue   `normaliseFieldValue` for the field's type, then
 *                   `encodeFieldValue` (JSON; null for REMOVE); a relation's
 *                   field (Phase 3.3) against its type's field; a new
 *                   element's first fields, each so, as one JSON object (or
 *                   null); a scene card's field (Phase 5.3) against the card's
 *                   field; a new relation's `{ note, fields }`, the note
 *                   `plainBlock`, each field so
 *   newName         `plainLine`
 *   newSummary      `plainBlock` (null when it sanitises to nothing)
 */
import type { BibleKind } from '@/lib/bible/kinds';
import { decodeFieldValue, encodeFieldValue, normaliseFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { FieldDef } from '@/lib/bible/template-schema';
import { getFieldDef, getRelationFieldDef } from '@/lib/bible/templates';
import { plainBlock, plainLine } from '@/lib/bible/text';
import { SCENE_CARD_FIELDS } from '@/lib/manuscript/scene-card';
import type { ProposalDraft } from './validate';

export interface StoredProposalText {
    proposedValue: string | null;
    newName: string | null;
    newSummary: string | null;
}

/** Thrown when a value that passed validation no longer normalises (a template changed under it): never stored. */
export class ProposalNotStorableError extends Error {
    constructor() {
        super('A proposal value could not be stored.');
        this.name = 'ProposalNotStorableError';
    }
}

/** One field value again through its definition; never stored when it no longer normalises. */
function storedValue(def: FieldDef | undefined, value: FieldValue): FieldValue {
    if (!def) throw new ProposalNotStorableError();
    const normalised = normaliseFieldValue(def, value);
    if (!normalised.ok || normalised.value === null) throw new ProposalNotStorableError();
    return normalised.value;
}

/**
 * What a draft's field is defined by: an element's kind (a FIELD, and a new
 * element's first fields), or a relation's type from its declaring kind (a
 * relation's field, and a new relation's fields; Phase 3.3).
 */
export type ProposalFieldOwner = { kind: BibleKind } | { relationType: string; fromKind: BibleKind } | { sceneCard: true } | null;

const defOf = (owner: ProposalFieldOwner, key: string): FieldDef | undefined =>
    owner === null ? undefined : 'sceneCard' in owner ? SCENE_CARD_FIELDS.find((f) => f.key === key) : 'relationType' in owner ? getRelationFieldDef(owner.fromKind, owner.relationType, key) : getFieldDef(owner.kind, key);

/** The columns a draft is stored as, sanitised (see the header). `owner` defines its fields; a kind alone is an element's. */
export function sanitiseProposalForStorage(draft: ProposalDraft, owner: BibleKind | ProposalFieldOwner): StoredProposalText {
    const fieldOwner: ProposalFieldOwner = typeof owner === 'string' ? { kind: owner } : owner;
    if (draft.kind === 'NEW_ELEMENT') {
        const summary = draft.summary === null ? '' : plainBlock(draft.summary);
        const fields = draft.fields.map((f) => [f.key, storedValue(getFieldDef(draft.newKind, f.key), f.value)] as const);
        return { proposedValue: fields.length > 0 ? JSON.stringify(Object.fromEntries(fields)) : null, newName: plainLine(draft.name), newSummary: summary === '' ? null : summary };
    }
    if (draft.kind === 'NEW_RELATION') {
        const note = draft.note === null ? '' : plainBlock(draft.note);
        const fields = draft.fields.map((f) => [f.key, storedValue(defOf(fieldOwner, f.key), f.value)] as const);
        return { proposedValue: JSON.stringify({ note: note === '' ? null : note, fields: Object.fromEntries(fields) }), newName: null, newSummary: null };
    }
    if (draft.operation === 'REMOVE' || draft.value === null) return { proposedValue: null, newName: null, newSummary: null };
    return { proposedValue: encodeFieldValue(storedValue(defOf(fieldOwner, draft.fieldKey), draft.value)), newName: null, newSummary: null };
}

/** A NEW_ELEMENT proposal's first fields back, by key (Phase 3.3); none for a NULL column. */
export function decodeNewElementFields(stored: string | null): Map<string, FieldValue> {
    if (stored === null) return new Map();
    const parsed = JSON.parse(stored) as Record<string, FieldValue>;
    return new Map(Object.entries(parsed));
}

/** A NEW_RELATION proposal's note and fields back (Phase 3.3). */
export function decodeNewRelation(stored: string | null): { note: string | null; fields: Map<string, FieldValue> } {
    if (stored === null) return { note: null, fields: new Map() };
    const parsed = JSON.parse(stored) as { note?: string | null; fields?: Record<string, FieldValue> };
    return { note: parsed.note ?? null, fields: new Map(Object.entries(parsed.fields ?? {})) };
}

/** A stored proposal value back to a field value (null for REMOVE). */
export function decodeProposedValue(stored: string | null): FieldValue | null {
    return stored === null ? null : decodeFieldValue(stored);
}
