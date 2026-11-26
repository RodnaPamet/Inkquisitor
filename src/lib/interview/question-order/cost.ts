/**
 * What one tie-break call can cost at most (Phase 4.4, D30 item 4): 4.1's worst-case formula over THIS prompt and
 * schema (the first attempt, every UTF-8 byte a token, the whole output budget, plus 2.1's one repair). Server-only.
 * The usecase ENFORCES the template's per-call budget with it, and holds the session's token budget to the tokens.
 */
import { jsonSchemaFor } from '@/lib/ai/client';
import { worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { buildModelRequest, inputTokenBound, neutralizeAuthorText, resolveCall, type AuthorDataBlock } from '@/lib/ai/prompt';
import { modelForTier } from '@/lib/ai/tiers';
import { ASSISTANT_TURN_BYTES_PER_TOKEN, REPAIR_TURN_BYTES } from '@/lib/sources/cost';
import { QUESTION_ORDER_MAX_OUTPUT_TOKENS, QUESTION_ORDER_PROMPT } from './prompt';
import { QuestionOrderOutputSchema } from './schema';

const NONCE_OF_A_REAL_LENGTH = '0'.repeat(32);
let outputSchema: Record<string, unknown> | null = null;

function firstAttemptTokens(blocks: readonly AuthorDataBlock[]): number {
    outputSchema ??= jsonSchemaFor(QuestionOrderOutputSchema);
    const empty = buildModelRequest(QUESTION_ORDER_PROMPT, blocks.map((b) => ({ label: b.label, text: '' })), resolveCall(QUESTION_ORDER_PROMPT), outputSchema, NONCE_OF_A_REAL_LENGTH);
    return inputTokenBound(empty) + blocks.reduce((n, b) => n + Buffer.byteLength(JSON.stringify(neutralizeAuthorText(b.text)), 'utf8') - 2, 0);
}

/** The tokens one call can spend at most (input and output, the repair included). */
export function questionOrderWorstTokens(blocks: readonly AuthorDataBlock[]): number {
    const first = firstAttemptTokens(blocks);
    const repair = first + QUESTION_ORDER_MAX_OUTPUT_TOKENS * ASSISTANT_TURN_BYTES_PER_TOKEN + REPAIR_TURN_BYTES;
    return first + QUESTION_ORDER_MAX_OUTPUT_TOKENS + repair + QUESTION_ORDER_MAX_OUTPUT_TOKENS;
}

/** What one call can cost at most, in micro-dollars. */
export function questionOrderWorstCase(blocks: readonly AuthorDataBlock[], model: string = modelForTier(QUESTION_ORDER_PROMPT.tier)): number {
    const first = firstAttemptTokens(blocks);
    const repair = first + QUESTION_ORDER_MAX_OUTPUT_TOKENS * ASSISTANT_TURN_BYTES_PER_TOKEN + REPAIR_TURN_BYTES;
    return worstCaseCostMicroUsd(model, { inputTokens: first, outputTokens: QUESTION_ORDER_MAX_OUTPUT_TOKENS }) + worstCaseCostMicroUsd(model, { inputTokens: repair, outputTokens: QUESTION_ORDER_MAX_OUTPUT_TOKENS });
}
