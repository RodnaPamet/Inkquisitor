/**
 * What one deep continuity call can cost at most (Phase 4.2, D28). Server-only
 * (the tier's model is configuration). The worst case is 4.1's formula over
 * THIS prompt and output schema (`src/lib/facts/cost.ts`): the first attempt
 * over the very request the call sends, every UTF-8 byte counted as a token,
 * with the whole output budget, PLUS the one repair 2.1 may make.
 *
 *   `continuityCallWorstCase(blocks)`  the call the night is about to make
 *   `continuityCallFloor()`            the least any call costs at worst (no facts): what the dispatcher asks the
 *                                      month's ledger to still have room for before it queues a book's deep step
 */
import { jsonSchemaFor } from '@/lib/ai/client';
import { worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { buildModelRequest, inputTokenBound, neutralizeAuthorText, resolveCall, type AuthorDataBlock } from '@/lib/ai/prompt';
import { modelForTier } from '@/lib/ai/tiers';
import { ASSISTANT_TURN_BYTES_PER_TOKEN, REPAIR_TURN_BYTES } from '@/lib/sources/cost';
import { CONTINUITY_MAX_OUTPUT_TOKENS, CONTINUITY_PROMPT, continuityBlocks } from './prompt';
import { ContinuityOutputSchema } from './schema';

const NONCE_OF_A_REAL_LENGTH = '0'.repeat(32);
let outputSchema: Record<string, unknown> | null = null;

function jsonStringBytes(text: string): number {
    return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/** 2.1's input bound for the call's first request over these blocks. */
export function continuityRequestInputBound(blocks: readonly AuthorDataBlock[]): number {
    outputSchema ??= jsonSchemaFor(ContinuityOutputSchema);
    const empty = buildModelRequest(CONTINUITY_PROMPT, blocks.map((b) => ({ label: b.label, text: '' })), resolveCall(CONTINUITY_PROMPT), outputSchema, NONCE_OF_A_REAL_LENGTH);
    return inputTokenBound(empty) + blocks.reduce((n, b) => n + jsonStringBytes(neutralizeAuthorText(b.text)), 0);
}

/** The call's worst case in µUSD: the first attempt and the one repair, each with the whole output budget. */
export function continuityCallWorstCase(blocks: readonly AuthorDataBlock[], model: string = modelForTier(CONTINUITY_PROMPT.tier)): number {
    const first = continuityRequestInputBound(blocks);
    const repair = first + CONTINUITY_MAX_OUTPUT_TOKENS * ASSISTANT_TURN_BYTES_PER_TOKEN + REPAIR_TURN_BYTES;
    return worstCaseCostMicroUsd(model, { inputTokens: first, outputTokens: CONTINUITY_MAX_OUTPUT_TOKENS }) + worstCaseCostMicroUsd(model, { inputTokens: repair, outputTokens: CONTINUITY_MAX_OUTPUT_TOKENS });
}

/** The least a call can cost at worst: the prompt and schema with one empty fact. */
export function continuityCallFloor(model: string = modelForTier(CONTINUITY_PROMPT.tier)): number {
    return continuityCallWorstCase(continuityBlocks({ facts: [{ predicate: 'OTHER', subjectName: '', statement: '', storyTimeFrom: null, storyTimeTo: null, at: null }], orders: [] }), model);
}
