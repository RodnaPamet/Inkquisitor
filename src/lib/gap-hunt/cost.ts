/**
 * What one gap ranking call can cost at most (Phase 4.3, D29): 4.1's worst-case
 * formula over THIS prompt and schema (the first attempt, every UTF-8 byte a
 * token, the whole output budget, plus 2.1's one repair). Server-only.
 */
import { jsonSchemaFor } from '@/lib/ai/client';
import { worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { buildModelRequest, inputTokenBound, neutralizeAuthorText, resolveCall, type AuthorDataBlock } from '@/lib/ai/prompt';
import { modelForTier } from '@/lib/ai/tiers';
import { ASSISTANT_TURN_BYTES_PER_TOKEN, REPAIR_TURN_BYTES } from '@/lib/sources/cost';
import { GAP_RANK_MAX_OUTPUT_TOKENS, GAP_RANK_PROMPT } from './prompt';
import { GapRankOutputSchema } from './schema';

const NONCE_OF_A_REAL_LENGTH = '0'.repeat(32);
let outputSchema: Record<string, unknown> | null = null;

function jsonStringBytes(text: string): number {
    return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

export function gapRankInputBound(blocks: readonly AuthorDataBlock[]): number {
    outputSchema ??= jsonSchemaFor(GapRankOutputSchema);
    const empty = buildModelRequest(GAP_RANK_PROMPT, blocks.map((b) => ({ label: b.label, text: '' })), resolveCall(GAP_RANK_PROMPT), outputSchema, NONCE_OF_A_REAL_LENGTH);
    return inputTokenBound(empty) + blocks.reduce((n, b) => n + jsonStringBytes(neutralizeAuthorText(b.text)), 0);
}

export function gapRankWorstCase(blocks: readonly AuthorDataBlock[], model: string = modelForTier(GAP_RANK_PROMPT.tier)): number {
    const first = gapRankInputBound(blocks);
    const repair = first + GAP_RANK_MAX_OUTPUT_TOKENS * ASSISTANT_TURN_BYTES_PER_TOKEN + REPAIR_TURN_BYTES;
    return worstCaseCostMicroUsd(model, { inputTokens: first, outputTokens: GAP_RANK_MAX_OUTPUT_TOKENS }) + worstCaseCostMicroUsd(model, { inputTokens: repair, outputTokens: GAP_RANK_MAX_OUTPUT_TOKENS });
}
