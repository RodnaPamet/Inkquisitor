/**
 * Request shapes for the enrichment API (Phase 2.5). Every object is
 * `.strict()`, so an unknown key is a 400 rather than silently dropped. These
 * bound the RAW input; the usecases sanitise every value (an edited field
 * value through `normaliseFieldValue`, a name and summary through
 * `plainLine` / `plainBlock`) before anything is stored.
 */
import { z } from 'zod';
import { RAW_INPUT_FACTOR } from '@/lib/bible/field-values';
import { BaseVersionInput, CHANGE_SUMMARY_MAX, ELEMENT_NAME_MAX, ELEMENT_SUMMARY_MAX, FieldValueInput } from './bible';

const id = z.string().min(1).max(64);
const raw = (max: number) => z.string().max(max * RAW_INPUT_FACTOR);

/** Proposals one bulk acceptance takes at most. */
export const BULK_ACCEPT_MAX = 50;

/**
 * Accept one proposal, as proposed or as the author edited it.
 *
 *   baseVersion      a FIELD proposal: the element's version the author's
 *                    review read (required: 1.H's rule). A newer one refuses
 *                    409 VERSION_CONFLICT.
 *   reviewedCurrent  the author saw the element's CURRENT value, which moved
 *                    since the proposal was made (409 PROPOSAL_OUTDATED
 *                    otherwise).
 *   value            an edit of an ADD or UPDATE (edit then accept)
 *   name, summary    an edit of a proposed new element
 *   changeSummary    the author's note on the version
 */
export const AcceptProposalInput = z
    .object({
        baseVersion: BaseVersionInput.optional(),
        reviewedCurrent: z.boolean().optional(),
        value: FieldValueInput.optional(),
        name: raw(ELEMENT_NAME_MAX).min(1).optional(),
        summary: raw(ELEMENT_SUMMARY_MAX).nullish(),
        changeSummary: raw(CHANGE_SUMMARY_MAX).nullish(),
    })
    .strict();
export type AcceptProposalInput = z.infer<typeof AcceptProposalInput>;

/** Accept several ADD proposals into fields still empty, each naming the version its element's review read. */
export const BulkAcceptInput = z
    .object({
        items: z
            .array(z.object({ proposalId: id, baseVersion: BaseVersionInput }).strict())
            .min(1)
            .max(BULK_ACCEPT_MAX)
            .refine((items) => new Set(items.map((i) => i.proposalId)).size === items.length, { message: 'A proposal is named at most once.' }),
    })
    .strict();
export type BulkAcceptInput = z.infer<typeof BulkAcceptInput>;

export const ProposalIdParam = id;
