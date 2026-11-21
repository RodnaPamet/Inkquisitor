/**
 * What extracting a source's facts will cost (Phase 4.0, D23: shown before
 * the job starts, and the author confirms it). Server-only (the tier's model
 * is configuration).
 *
 *   expected     each chunk's prompt at `CHARS_PER_TOKEN`, and `EXPECTED_OUTPUT_TOKENS` back
 *   at most      each chunk's prompt at one token a UTF-8 byte (no token is
 *                shorter) and the call's whole output budget — 2.1's own
 *                worst-case reading (`worstCaseCostMicroUsd`)
 *
 * The confirmed "at most" is the ingestion's BUDGET: before each chunk the job
 * asks whether that chunk's worst case still fits what is left of it, with the
 * same function, so an ingestion stops BUDGET only when a resume was confirmed
 * for less than its remaining chunks. The monthly ceiling (D10) is checked by
 * 2.1 before every call, independently.
 */
import { costMicroUsd, worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { modelForTier } from '@/lib/ai/tiers';
import { EXTRACT_MAX_OUTPUT_TOKENS, EXTRACT_PROMPT } from './prompt';
import { CHARS_PER_TOKEN } from './vocabulary';

/** Output tokens a chunk's answer is expected to take (a handful of facts). */
export const EXPECTED_OUTPUT_TOKENS = 700;
/** Bytes the request adds around the passage: the fences, the labels, the output schema. */
export const REQUEST_OVERHEAD_BYTES = 6_000;

const PROMPT_BYTES = Buffer.byteLength(EXTRACT_PROMPT.system, 'utf8') + Buffer.byteLength(EXTRACT_PROMPT.task, 'utf8');

export interface ChunkCostInput {
    /** The passage and its headings, as sent. */
    readonly text: string;
    /** The book's names block, as sent ('' for the series library). */
    readonly namesText: string;
}

export function chunkCost(chunk: ChunkCostInput, model: string = modelForTier(EXTRACT_PROMPT.tier)): { expected: number; worst: number } {
    const bytes = PROMPT_BYTES + REQUEST_OVERHEAD_BYTES + Buffer.byteLength(chunk.text, 'utf8') + Buffer.byteLength(chunk.namesText, 'utf8');
    const chars = EXTRACT_PROMPT.system.length + EXTRACT_PROMPT.task.length + chunk.text.length + chunk.namesText.length;
    return {
        expected: costMicroUsd(model, { inputTokens: Math.ceil(chars / CHARS_PER_TOKEN), outputTokens: EXPECTED_OUTPUT_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0 }),
        worst: worstCaseCostMicroUsd(model, { inputTokens: bytes, outputTokens: EXTRACT_MAX_OUTPUT_TOKENS }),
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
