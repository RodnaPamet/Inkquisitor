/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between the gap hunt's ranking (4.3) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultGapRanker(ctx)` is 4.0's call contract (`FactExtractor`) over the
 * workspace-bound `callStructured` with GAP_RANK_PROMPT and
 * `GapRankOutputSchema`: one balanced call, reserved against the monthly
 * ceiling before it is sent, its failure named (`extractOutcomeOf`).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured } from '@/app-layer/usecases/model-calls';
import type { StructuredCallDeps, StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import type { FactExtractor } from '@/lib/sources/extractor';
import { extractOutcomeOf } from '@/lib/sources/model-seam';
import { GAP_RANK_PROMPT } from './prompt';
import { GapRankOutputSchema } from './schema';

export type GapRanker = FactExtractor;

export type GapRankCaller = (input: Omit<StructuredCallInput<typeof GapRankOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

export function gapRankerOver(call: GapRankCaller): GapRanker {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await call({ template: GAP_RANK_PROMPT, data: request.data, schema: GapRankOutputSchema, bookId: request.bookId, signal });
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                return extractOutcomeOf(err);
            }
        },
    } satisfies GapRanker);
}

export function defaultGapRanker(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}): GapRanker {
    return gapRankerOver((input) => callStructured(ctx, input, deps));
}
