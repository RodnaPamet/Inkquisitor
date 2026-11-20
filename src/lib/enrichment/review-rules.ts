/**
 * The rules a review reads (Phase 2.5), pure and client-safe: whether an
 * operation still fits the field it targets, and whether a proposal may be
 * offered for bulk acceptance. The server applies them again when the author
 * acts (`src/app-layer/usecases/enrichment-review.ts`).
 */
import type { FieldValue } from '@/lib/bible/field-values';
import type { ProposalStatus, StoredOp } from './vocabulary';

/** An op still fits its field: ADD only into an empty field, UPDATE and REMOVE only on a filled one. */
export function opFits(op: StoredOp, current: FieldValue | null): boolean {
    const empty = current === null || (Array.isArray(current) && current.length === 0) || current === '';
    return op === 'ADD' ? empty : !empty;
}

/**
 * Offered for bulk acceptance: a PENDING ADD into a field that is still empty
 * and carries no flag (a POSSIBLE_INSTRUCTION is decided one by one, D14).
 * Nothing else is ever accepted in bulk.
 */
export function bulkEligible(p: { status: ProposalStatus; operation: StoredOp; flags: readonly string[] }, current: FieldValue | null): boolean {
    return p.status === 'PENDING' && p.operation === 'ADD' && p.flags.length === 0 && opFits('ADD', current);
}
