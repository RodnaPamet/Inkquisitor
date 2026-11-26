/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between long-session compaction (4.3) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultRoundsSummarizer(ctx)` is 4.0's call contract (`FactExtractor`) over
 * the workspace-bound `callStructured` with COMPACTION_PROMPT: one fast call,
 * held to the monthly ceiling and the kill switch, recorded in `AiCallLog`, its
 * data guard-scanned and fenced like every call. Its failure is named
 * (`extractOutcomeOf`); any failure leaves the round uncompacted.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured } from '@/app-layer/usecases/model-calls';
import type { StructuredCallDeps, StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import { jsonSchemaFor } from '@/lib/ai/client';
import { buildModelRequest, inputTokenBound, neutralizeAuthorText, resolveCall, type AuthorDataBlock } from '@/lib/ai/prompt';
import { ASSISTANT_TURN_BYTES_PER_TOKEN, REPAIR_TURN_BYTES } from '@/lib/sources/cost';
import type { FactExtractor } from '@/lib/sources/extractor';
import { extractOutcomeOf } from '@/lib/sources/model-seam';
import { COMPACTION_MAX_OUTPUT_TOKENS, COMPACTION_PROMPT, RoundsSummaryOutputSchema } from './compaction-prompt';

const NONCE_OF_A_REAL_LENGTH = '0'.repeat(32);
let outputSchema: Record<string, unknown> | null = null;

/**
 * The tokens one summary call can spend at most over these blocks (2.1's bound, as the stress test's cost is
 * reckoned): the first attempt's input bound and whole output budget, plus the one repair 2.1 may make. The usecase
 * holds the session's token budget to it BEFORE the call, as every model feature does (2.H).
 */
export function compactionCallWorstTokens(blocks: readonly AuthorDataBlock[]): number {
    outputSchema ??= jsonSchemaFor(RoundsSummaryOutputSchema);
    const empty = buildModelRequest(COMPACTION_PROMPT, blocks.map((b) => ({ label: b.label, text: '' })), resolveCall(COMPACTION_PROMPT), outputSchema, NONCE_OF_A_REAL_LENGTH);
    const first = inputTokenBound(empty) + blocks.reduce((n, b) => n + Buffer.byteLength(JSON.stringify(neutralizeAuthorText(b.text)), 'utf8') - 2, 0);
    const repair = first + COMPACTION_MAX_OUTPUT_TOKENS * ASSISTANT_TURN_BYTES_PER_TOKEN + REPAIR_TURN_BYTES;
    return first + COMPACTION_MAX_OUTPUT_TOKENS + repair + COMPACTION_MAX_OUTPUT_TOKENS;
}

export type RoundsSummarizer = FactExtractor;

export type RoundsSummaryCaller = (input: Omit<StructuredCallInput<typeof RoundsSummaryOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

/** The summary call over any caller (the deployment's below; the injection suite's compromised one). */
export function roundsSummarizerOver(call: RoundsSummaryCaller): RoundsSummarizer {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await call({ template: COMPACTION_PROMPT, data: request.data, schema: RoundsSummaryOutputSchema, bookId: request.bookId, signal });
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                return extractOutcomeOf(err);
            }
        },
    } satisfies RoundsSummarizer);
}

export function defaultRoundsSummarizer(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}): RoundsSummarizer {
    return roundsSummarizerOver((input) => callStructured(ctx, input, deps));
}
