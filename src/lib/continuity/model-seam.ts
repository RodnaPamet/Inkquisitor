/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between the deep continuity check (4.2) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultContinuityChecker(ctx)` is 4.0's call contract (`FactExtractor`: one
 * structured call, its cost and its failure named) over the workspace-bound
 * `callStructured` with CONTINUITY_PROMPT and `ContinuityOutputSchema`: one deep
 * call per page, reserved against the monthly ceiling before it is sent. 2.1's
 * outcomes map exactly as they do for a chunk (`extractOutcomeOf`, the table in
 * `src/lib/sources/model-seam.ts`): KILL_SWITCH, WORKSPACE_CEILING and
 * AI_UNAVAILABLE stop the night, resumable; the rest are the call's own failure.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured, type NightlyShare } from '@/app-layer/usecases/model-calls';
import { AiSpendCeilingError } from '@/lib/ai/errors';
import type { StructuredCallDeps, StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import type { FactExtractor } from '@/lib/sources/extractor';
import { extractOutcomeOf } from '@/lib/sources/model-seam';
import { CONTINUITY_PROMPT } from './prompt';
import { ContinuityOutputSchema } from './schema';

/** A deep check is one structured call: the same contract as 4.0's extractor. */
export type ContinuityChecker = FactExtractor;

export type ContinuityCaller = (input: Omit<StructuredCallInput<typeof ContinuityOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

export function continuityCheckerOver(call: ContinuityCaller): ContinuityChecker {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await call({ template: CONTINUITY_PROMPT, data: request.data, schema: ContinuityOutputSchema, bookId: request.bookId, signal });
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                // The night's share of the month (D28 addendum), refused by the ledger under its lock: named apart from the
                // month's ceiling, so the night stops NIGHTLY_CAP.
                const share = err instanceof AiSpendCeilingError && (err.details as { limit?: unknown } | undefined)?.limit === 'NIGHTLY_SHARE';
                const outcome = extractOutcomeOf(err);
                return share && !outcome.ok ? { ...outcome, errorCode: NIGHTLY_SHARE_REFUSED } : outcome;
            }
        },
    } satisfies ContinuityChecker);
}

/** The error code a call refused at the night's share carries (`extractOutcomeOf`'s WORKSPACE_CEILING otherwise). */
export const NIGHTLY_SHARE_REFUSED = 'NIGHTLY_SHARE';

/**
 * The deployment's checker, in the context's workspace, as its user, its every reservation held to the night's share
 * (`share`, D28 addendum) by the ledger. `deps` is the tests' fetch seam.
 */
export function defaultContinuityChecker(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}, share?: NightlyShare): ContinuityChecker {
    return continuityCheckerOver((input) => callStructured(ctx, input, deps, { share }));
}
