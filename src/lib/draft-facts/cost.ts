/**
 * What one draft-reading call can cost at worst (Phase 5.3; rule 9, the per-call budget ENFORCED). Server-only (the
 * tier's model is configuration). The first attempt over the very request the call builds (2.1's `inputTokenBound`
 * over the blocks it sends: the request built with the blocks emptied, plus each block's text as the fence writes it
 * and the body serialises it) with the whole output budget, PLUS the one repair attempt 2.1 may make — as 4.0's and
 * 4.1's prompts are priced (`sources/cost.ts`).
 */
import { jsonSchemaFor } from '@/lib/ai/client';
import { worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { buildModelRequest, inputTokenBound, neutralizeAuthorText, resolveCall, type AuthorDataBlock } from '@/lib/ai/prompt';
import { modelForTier } from '@/lib/ai/tiers';
import { ASSISTANT_TURN_BYTES_PER_TOKEN, REPAIR_TURN_BYTES } from '@/lib/sources/cost';
import { DRAFT_READ_MAX_OUTPUT_TOKENS, DRAFT_READ_PROMPT } from './prompt';
import { DraftReadOutputSchema } from './schema';

const NONCE_OF_A_REAL_LENGTH = '0'.repeat(32);
let outputSchema: Record<string, unknown> | null = null;

function jsonStringBytes(text: string): number {
    return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/** 2.1's input bound for the call's first request over these blocks. */
export function draftReadRequestInputBound(blocks: readonly AuthorDataBlock[]): number {
    outputSchema ??= jsonSchemaFor(DraftReadOutputSchema);
    const empty = buildModelRequest(DRAFT_READ_PROMPT, blocks.map((b) => ({ label: b.label, text: '' })), resolveCall(DRAFT_READ_PROMPT), outputSchema, NONCE_OF_A_REAL_LENGTH);
    return inputTokenBound(empty) + blocks.reduce((n, b) => n + jsonStringBytes(neutralizeAuthorText(b.text)), 0);
}

/** The call's worst case in µUSD: the first attempt and the one repair, each with the whole output budget. */
export function draftReadCallWorstCase(blocks: readonly AuthorDataBlock[], model: string = modelForTier(DRAFT_READ_PROMPT.tier)): number {
    const first = draftReadRequestInputBound(blocks);
    const repair = first + DRAFT_READ_MAX_OUTPUT_TOKENS * ASSISTANT_TURN_BYTES_PER_TOKEN + REPAIR_TURN_BYTES;
    return worstCaseCostMicroUsd(model, { inputTokens: first, outputTokens: DRAFT_READ_MAX_OUTPUT_TOKENS }) + worstCaseCostMicroUsd(model, { inputTokens: repair, outputTokens: DRAFT_READ_MAX_OUTPUT_TOKENS });
}
