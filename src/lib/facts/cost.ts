/**
 * What one bible fact call can cost at most (Phase 4.1, D27; owner decisions of
 * 2026-11-21). Server-only (the tier's model is configuration).
 *
 * The worst case is 4.0's for a chunk (`src/lib/sources/cost.ts`), over THIS
 * prompt and output schema: the FIRST attempt over the very request the call
 * sends (`buildModelRequest` over the call's data blocks, measured as 2.1's
 * `inputTokenBound` does: UTF-8 bytes, JSON-escaped, fence and all) with the
 * whole output budget, PLUS the one REPAIR attempt 2.1 may make (that request
 * again, the model's answer and the repair turn, the whole output budget again).
 *
 *   `bibleFactsCallWorstCase(blocks)`  the call the extraction is about to make
 *   `bibleFactsCallFloor()`            the least any call costs at worst (no entry
 *                                      text, no existing facts, no names): what the
 *                                      dispatcher asks the month's ledger to still
 *                                      have room for before it queues a workspace's
 *                                      extractions
 */
import { jsonSchemaFor } from '@/lib/ai/client';
import { worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { buildModelRequest, inputTokenBound, neutralizeAuthorText, resolveCall, type AuthorDataBlock } from '@/lib/ai/prompt';
import { modelForTier } from '@/lib/ai/tiers';
import { ASSISTANT_TURN_BYTES_PER_TOKEN, REPAIR_TURN_BYTES } from '@/lib/sources/cost';
import { BIBLE_FACTS_MAX_OUTPUT_TOKENS, BIBLE_FACTS_PROMPT, bibleFactBlocks } from './prompt';
import { BibleFactsOutputSchema } from './schema';

const NONCE_OF_A_REAL_LENGTH = '0'.repeat(32);
let outputSchema: Record<string, unknown> | null = null;

function jsonStringBytes(text: string): number {
    return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/** 2.1's input bound for the call's first request over these blocks (byte for byte what the body holds; see sources/cost.ts). */
export function bibleFactsRequestInputBound(blocks: readonly AuthorDataBlock[]): number {
    outputSchema ??= jsonSchemaFor(BibleFactsOutputSchema);
    const empty = buildModelRequest(BIBLE_FACTS_PROMPT, blocks.map((b) => ({ label: b.label, text: '' })), resolveCall(BIBLE_FACTS_PROMPT), outputSchema, NONCE_OF_A_REAL_LENGTH);
    return inputTokenBound(empty) + blocks.reduce((n, b) => n + jsonStringBytes(neutralizeAuthorText(b.text)), 0);
}

/** The call's worst case in µUSD: the first attempt and the one repair, each with the whole output budget. */
export function bibleFactsCallWorstCase(blocks: readonly AuthorDataBlock[], model: string = modelForTier(BIBLE_FACTS_PROMPT.tier)): number {
    const first = bibleFactsRequestInputBound(blocks);
    const repair = first + BIBLE_FACTS_MAX_OUTPUT_TOKENS * ASSISTANT_TURN_BYTES_PER_TOKEN + REPAIR_TURN_BYTES;
    return worstCaseCostMicroUsd(model, { inputTokens: first, outputTokens: BIBLE_FACTS_MAX_OUTPUT_TOKENS }) + worstCaseCostMicroUsd(model, { inputTokens: repair, outputTokens: BIBLE_FACTS_MAX_OUTPUT_TOKENS });
}

/** The least a call can cost at worst: the prompt and schema with an entry of no text (the dispatcher's question to the ledger). */
export function bibleFactsCallFloor(model: string = modelForTier(BIBLE_FACTS_PROMPT.tier)): number {
    return bibleFactsCallWorstCase(bibleFactBlocks({ text: '', subjects: [''], existing: [], bookNames: [] }), model);
}
