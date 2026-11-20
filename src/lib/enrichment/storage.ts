/**
 * A proposal on its way into the database (Phase 2.5), sanitised as author
 * text once more, whatever produced it: a proposal's value is model output
 * built from the author's answers, and a new element's name and summary are
 * the author's words. `validate.ts` has already normalised the value; this is
 * the write path's own guarantee (the encrypted-field sanitiser guard holds
 * every writer of the three columns to it).
 *
 *   proposedValue   `normaliseFieldValue` for the field's type, then
 *                   `encodeFieldValue` (JSON; null for REMOVE)
 *   newName         `plainLine`
 *   newSummary      `plainBlock` (null when it sanitises to nothing)
 */
import type { BibleKind } from '@/lib/bible/kinds';
import { decodeFieldValue, encodeFieldValue, normaliseFieldValue, type FieldValue } from '@/lib/bible/field-values';
import { getFieldDef } from '@/lib/bible/templates';
import { plainBlock, plainLine } from '@/lib/bible/text';
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

/** The columns a draft is stored as, sanitised (see the header). */
export function sanitiseProposalForStorage(draft: ProposalDraft, elementKind: BibleKind | null): StoredProposalText {
    if (draft.kind === 'NEW_ELEMENT') {
        const summary = draft.summary === null ? '' : plainBlock(draft.summary);
        return { proposedValue: null, newName: plainLine(draft.name), newSummary: summary === '' ? null : summary };
    }
    if (draft.operation === 'REMOVE' || draft.value === null) return { proposedValue: null, newName: null, newSummary: null };
    const def = elementKind ? getFieldDef(elementKind, draft.fieldKey) : undefined;
    if (!def) throw new ProposalNotStorableError();
    const normalised = normaliseFieldValue(def, draft.value);
    if (!normalised.ok || normalised.value === null) throw new ProposalNotStorableError();
    return { proposedValue: encodeFieldValue(normalised.value), newName: null, newSummary: null };
}

/** A stored proposal value back to a field value (null for REMOVE). */
export function decodeProposedValue(stored: string | null): FieldValue | null {
    return stored === null ? null : decodeFieldValue(stored);
}
