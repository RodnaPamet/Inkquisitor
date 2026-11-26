/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between the stress test (4.3) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultStressTester(ctx)` is 4.0's call contract (`FactExtractor`: one
 * structured call, its cost and its failure named) over the workspace-bound
 * `callStructured` with STRESS_TEST_PROMPT and `StressTestOutputSchema`: one
 * deep call, reserved against the monthly ceiling before it is sent. 2.1's
 * outcomes map exactly as they do for a chunk (`extractOutcomeOf`, the table in
 * `src/lib/sources/model-seam.ts`): KILL_SWITCH, WORKSPACE_CEILING and
 * AI_UNAVAILABLE stop the test, the rest are the call's own failure.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured } from '@/app-layer/usecases/model-calls';
import type { StructuredCallDeps, StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import type { FactExtractor } from '@/lib/sources/extractor';
import { extractOutcomeOf } from '@/lib/sources/model-seam';
import { STRESS_TEST_PROMPT } from './prompt';
import { StressTestOutputSchema } from './schema';

/** A stress test is one structured call: the same contract as 4.0's extractor. */
export type StressTester = FactExtractor;

export type StressTestCaller = (input: Omit<StructuredCallInput<typeof StressTestOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

export function stressTesterOver(call: StressTestCaller): StressTester {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await call({ template: STRESS_TEST_PROMPT, data: request.data, schema: StressTestOutputSchema, bookId: request.bookId, signal });
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                return extractOutcomeOf(err);
            }
        },
    } satisfies StressTester);
}

/** The deployment's stress tester, in the context's workspace, as its user. `deps` is the tests' fetch seam. */
export function defaultStressTester(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}): StressTester {
    return stressTesterOver((input) => callStructured(ctx, input, deps));
}
