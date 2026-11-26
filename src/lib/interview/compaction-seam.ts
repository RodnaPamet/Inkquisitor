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
import type { StructuredCallDeps } from '@/lib/ai/call-structured';
import type { FactExtractor } from '@/lib/sources/extractor';
import { extractOutcomeOf } from '@/lib/sources/model-seam';
import { COMPACTION_PROMPT, RoundsSummaryOutputSchema } from './compaction-prompt';

export type RoundsSummarizer = FactExtractor;

export function defaultRoundsSummarizer(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}): RoundsSummarizer {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await callStructured(ctx, { template: COMPACTION_PROMPT, data: request.data, schema: RoundsSummaryOutputSchema, bookId: request.bookId, signal }, deps);
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                return extractOutcomeOf(err);
            }
        },
    } satisfies RoundsSummarizer);
}
