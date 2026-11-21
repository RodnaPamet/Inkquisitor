/**
 * What extracting a source's facts will cost (Phase 4.0, D23: shown before
 * the job starts, and the author confirms it). Server-only (the tier's model
 * is configuration).
 *
 *   expected     each chunk's prompt at `CHARS_PER_TOKEN`, and `EXPECTED_OUTPUT_TOKENS` back
 *   at most      what 2.1 can charge for the chunk's call, at the model's dearest
 *                rates (`worstCaseCostMicroUsd`): the FIRST attempt over the
 *                very request the call sends (`buildModelRequest` over the
 *                chunk's data blocks: its UTF-8 bytes with JSON escaping and the
 *                fence, the system prompt and the output schema, 2.1's own
 *                `inputTokenBound`) with the whole output budget, PLUS the one
 *                REPAIR attempt 2.1 may make (that request again, the model's
 *                answer and the repair turn, with the whole output budget again)
 *
 * The confirmed "at most" is the ingestion's BUDGET: before each chunk the job
 * asks whether that chunk's worst case still fits what is left of it, with the
 * same function over the same blocks, so a job never spends more than the
 * author confirmed — a repaired call included. The monthly ceiling (D10) is
 * checked by 2.1 before every call, independently.
 */
import { jsonSchemaFor } from '@/lib/ai/client';
import { costMicroUsd, worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { buildModelRequest, inputTokenBound, resolveCall } from '@/lib/ai/prompt';
import { modelForTier } from '@/lib/ai/tiers';
import { EXTRACT_MAX_OUTPUT_TOKENS, EXTRACT_PROMPT, extractBlocks } from './prompt';
import { FactsOutputSchema } from './schema';
import { CHARS_PER_TOKEN } from './vocabulary';

/** Output tokens a chunk's answer is expected to take (a handful of facts). */
export const EXPECTED_OUTPUT_TOKENS = 700;
/**
 * The repair attempt's input beyond the first request: the model's answer sent back (at most
 * `ASSISTANT_TURN_BYTES_PER_TOKEN` UTF-8 bytes, JSON-escaped, for each of its at most
 * `EXTRACT_MAX_OUTPUT_TOKENS` tokens) and the repair turn (at most 20 issues, each a path, a code and a
 * fixed sentence: `REPAIR_TURN_BYTES`).
 */
export const ASSISTANT_TURN_BYTES_PER_TOKEN = 16;
export const REPAIR_TURN_BYTES = 8_192;

/** A 32-hex fence nonce: every real nonce is this long, so the request's size does not depend on which one is drawn. */
const NONCE_OF_A_REAL_LENGTH = '0'.repeat(32);

let outputSchema: Record<string, unknown> | null = null;

export interface ChunkCostInput {
    /** The chunk's heading path, as sent (`passage.headings`). */
    readonly headings: readonly string[];
    /** The passage, as stored and sent (`passage.text`). */
    readonly text: string;
    /** The book's element names, as sent (`book-names`; none for the series library). */
    readonly bookNames: readonly string[];
}

/** 2.1's input bound (`inputTokenBound`) for the chunk's first request, over the blocks the job sends. */
export function chunkRequestInputBound(chunk: ChunkCostInput): number {
    outputSchema ??= jsonSchemaFor(FactsOutputSchema);
    const request = buildModelRequest(EXTRACT_PROMPT, extractBlocks(chunk), resolveCall(EXTRACT_PROMPT), outputSchema, NONCE_OF_A_REAL_LENGTH);
    return inputTokenBound(request);
}

export function chunkCost(chunk: ChunkCostInput, model: string = modelForTier(EXTRACT_PROMPT.tier)): { expected: number; worst: number } {
    const chars = EXTRACT_PROMPT.system.length + EXTRACT_PROMPT.task.length + chunk.headings.join(' › ').length + chunk.text.length + chunk.bookNames.join('\n').length;
    const first = chunkRequestInputBound(chunk);
    const repair = first + EXTRACT_MAX_OUTPUT_TOKENS * ASSISTANT_TURN_BYTES_PER_TOKEN + REPAIR_TURN_BYTES;
    return {
        expected: costMicroUsd(model, { inputTokens: Math.ceil(chars / CHARS_PER_TOKEN), outputTokens: EXPECTED_OUTPUT_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0 }),
        worst:
            worstCaseCostMicroUsd(model, { inputTokens: first, outputTokens: EXTRACT_MAX_OUTPUT_TOKENS }) +
            worstCaseCostMicroUsd(model, { inputTokens: repair, outputTokens: EXTRACT_MAX_OUTPUT_TOKENS }),
    };
}

/** A source's estimate: the sum over its chunks. */
export function sourceCost(chunks: readonly ChunkCostInput[], model: string = modelForTier(EXTRACT_PROMPT.tier)): { expected: number; worst: number } {
    let expected = 0;
    let worst = 0;
    for (const c of chunks) {
        const one = chunkCost(c, model);
        expected += one.expected;
        worst += one.worst;
    }
    return { expected, worst };
}
