/**
 * Request shapes for the source library API (Phase 4.0). Every object is
 * `.strict()`. They bound the RAW input; the usecases sanitise every value
 * before anything is stored.
 */
import { z } from 'zod';
import { FACT_PROPOSAL_DECISIONS } from '@/lib/facts/vocabulary';
import { FACTS_PER_VIEW_MAX, OVERRIDE_TEXT_MAX } from '@/lib/sources/vocabulary';

const id = z.string().min(1).max(64);

export const IngestInput = z.object({ confirmWorstCaseMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();

export const DecisionInput = z.object({ decision: z.enum(['CONFIRM', 'REJECT']) }).strict();

export const BulkConfirmInput = z
    .object({
        view: z.discriminatedUnion('kind', [z.object({ kind: z.literal('book'), bookId: id }).strict(), z.object({ kind: z.literal('series') }).strict()]),
        offeredIds: z.array(id).max(FACTS_PER_VIEW_MAX),
        issuedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        token: z.string().min(1).max(200),
        factIds: z.array(id).min(1).max(FACTS_PER_VIEW_MAX),
    })
    .strict();

export const OverrideInput = z.object({ text: z.string().max(OVERRIDE_TEXT_MAX * 4) }).strict();

/** The upload's file name travels in this header, percent-encoded (never the URL: a query string reaches request spans and access logs). */
export const SOURCE_FILENAME_HEADER = 'x-source-filename';

/** The header's file name, decoded and bounded; '' when absent or malformed. */
export function filenameFromHeader(value: string | null): string {
    if (!value) return '';
    try {
        return decodeURIComponent(value.slice(0, 2_400)).slice(0, 800);
    } catch {
        return '';
    }
}

/** Phase 4.1 (D27): the author's answer to a proposal to invalidate a fact. */
export const FactProposalDecisionInput = z.object({ decision: z.enum(FACT_PROPOSAL_DECISIONS) }).strict();
