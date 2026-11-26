/**
 * What one stress test call can cost at most (Phase 4.3, D29). Server-only
 * (the tier's model is configuration). The worst case is 4.1's formula over
 * THIS prompt and output schema (`src/lib/continuity/cost.ts` is its twin): the
 * first attempt over the very request the call sends, every UTF-8 byte counted
 * as a token, with the whole output budget, PLUS the one repair 2.1 may make.
 *
 *   `stressTestWorstCase(blocks)`  the call about to be made (what the author confirms, and the job's budget)
 *   `fitStressInput(sources)`      the input cut until its worst case fits the ENFORCED per-call budget
 */
import { jsonSchemaFor } from '@/lib/ai/client';
import { worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { buildModelRequest, inputTokenBound, neutralizeAuthorText, resolveCall, type AuthorDataBlock } from '@/lib/ai/prompt';
import { modelForTier } from '@/lib/ai/tiers';
import { ASSISTANT_TURN_BYTES_PER_TOKEN, REPAIR_TURN_BYTES } from '@/lib/sources/cost';
import { buildStressInput, type StressInput, type StressInputSources } from './input';
import { STRESS_TEST_CALL_COST_BUDGET_MICRO_USD, STRESS_TEST_MAX_OUTPUT_TOKENS, STRESS_TEST_PROMPT } from './prompt';
import { StressTestOutputSchema } from './schema';
import { STRESS_INPUT_CHAR_BUDGET, STRESS_INPUT_CHAR_BUDGET_MIN } from './vocabulary';

const NONCE_OF_A_REAL_LENGTH = '0'.repeat(32);
let outputSchema: Record<string, unknown> | null = null;

function jsonStringBytes(text: string): number {
    return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/** 2.1's input bound for the call's first request over these blocks. */
export function stressTestInputBound(blocks: readonly AuthorDataBlock[]): number {
    outputSchema ??= jsonSchemaFor(StressTestOutputSchema);
    const empty = buildModelRequest(STRESS_TEST_PROMPT, blocks.map((b) => ({ label: b.label, text: '' })), resolveCall(STRESS_TEST_PROMPT), outputSchema, NONCE_OF_A_REAL_LENGTH);
    return inputTokenBound(empty) + blocks.reduce((n, b) => n + jsonStringBytes(neutralizeAuthorText(b.text)), 0);
}

/** The call's worst case in µUSD: the first attempt and the one repair, each with the whole output budget. */
export function stressTestWorstCase(blocks: readonly AuthorDataBlock[], model: string = modelForTier(STRESS_TEST_PROMPT.tier)): number {
    const first = stressTestInputBound(blocks);
    const repair = first + STRESS_TEST_MAX_OUTPUT_TOKENS * ASSISTANT_TURN_BYTES_PER_TOKEN + REPAIR_TURN_BYTES;
    return worstCaseCostMicroUsd(model, { inputTokens: first, outputTokens: STRESS_TEST_MAX_OUTPUT_TOKENS }) + worstCaseCostMicroUsd(model, { inputTokens: repair, outputTokens: STRESS_TEST_MAX_OUTPUT_TOKENS });
}

export type FittedStressInput = ({ ok: true; worstMicroUsd: number } & StressInput) | { ok: false; reason: 'CALL_OVER_BUDGET'; worstMicroUsd: number };

/**
 * The input at the largest budget whose call fits the per-call cost budget: the full budget, then halved, down to
 * `STRESS_INPUT_CHAR_BUDGET_MIN`; past that the call is not made (CALL_OVER_BUDGET). Deterministic over its
 * sources, so the estimate the author confirms and the job's call are the same input when the book has not moved.
 */
export function fitStressInput(
    sources: StressInputSources,
    worst: (blocks: readonly AuthorDataBlock[]) => number = (b) => stressTestWorstCase(b),
    budgetMicroUsd: number = STRESS_TEST_CALL_COST_BUDGET_MICRO_USD,
): FittedStressInput {
    let last = 0;
    for (let chars = STRESS_INPUT_CHAR_BUDGET; chars >= STRESS_INPUT_CHAR_BUDGET_MIN; chars = Math.floor(chars / 2)) {
        const input = buildStressInput(sources, chars);
        last = worst(input.blocks);
        if (last <= budgetMicroUsd) return { ok: true, worstMicroUsd: last, ...input };
    }
    return { ok: false, reason: 'CALL_OVER_BUDGET', worstMicroUsd: last };
}
