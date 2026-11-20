/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between enrichment's reconcile step (2.5) and the model
 *  layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultReconciler(ctx)` is a `Reconciler` (`./reconciler.ts`) over 2.1's
 * `callStructured(ctx, { template, data, schema, bookId, signal })`
 * (`src/app-layer/usecases/model-calls.ts`): the reconcile template, the
 * author text as data blocks (2.1 fences and guard-scans them), the strict
 * output schema. Every call is recorded in `AiCallLog` and held to the
 * workspace's spend ceiling by 2.1. Calling the model needs no permission of
 * its own: the enrichment usecase checks `bible.edit` before it reaches here.
 *
 * ── 2.1 OUTCOME → THE RUN ──────────────────────────────────────────────────
 *
 *   OK, REPAIRED              the output, tokens, call id, cost, the guard's flag
 *   KILLED (AI_DISABLED)      failure KILL_SWITCH: nothing was sent
 *   CEILING                   failure WORKSPACE_CEILING: nothing was sent
 *   PROVIDER_ERROR by configuration (no key, ambient headers, no retention mode)
 *                             failure AI_UNAVAILABLE (normally unreachable: the
 *                             usecase asks `unavailableReason()` first)
 *   REFUSED_GUARD             failure GUARD_REFUSED
 *   TIMEOUT                   failure TIMEOUT
 *   ABORTED                   failure ABORTED
 *   PROVIDER_ERROR            failure PROVIDER_FAILURE (HTTP, connection, a model
 *                             refusal, a request refused on its way out)
 *   INVALID_OUTPUT            failure INVALID_OUTPUT
 *   AiPromptError             failure PROMPT_INVALID, logged as the programming
 *                             error it is; never a 500, never invented output
 *
 * Nothing is ever proposed from a failed call. Tokens and cost travel with a
 * failure as with an answer (`AiCallError.tokensUsed`, `.costMicroUsd`).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured, modelUnavailableReason } from '@/app-layer/usecases/model-calls';
import type { StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import {
    AiCallAbortedError,
    AiCallError,
    AiGuardBlockedError,
    AiOutputInvalidError,
    AiPromptError,
    AiProviderError,
    AiSpendCeilingError,
    AiTimeoutError,
    AiUnavailableError,
} from '@/lib/ai/errors';
import { modelForTier } from '@/lib/ai/tiers';
import { logger } from '@/lib/observability/logger';
import type { z } from 'zod';
import { RECONCILE_PROMPT } from './prompt';
import type { ReconcileCallFailure, ReconcileCallResult, Reconciler } from './reconciler';
import type { ReconcileOutputSchema } from './schema';

type Schema = typeof ReconcileOutputSchema;

/** One structured call with the workspace bound: the deployment's, or a test's over the fake Messages API. */
export type ReconcileCaller = (input: Omit<StructuredCallInput<Schema>, 'requestedById'>) => Promise<StructuredCallResult<z.infer<Schema>>>;

function failed(outcome: ReconcileCallFailure, err: AiCallError): ReconcileCallResult {
    return {
        output: null,
        tokensUsed: err.tokensUsed,
        failure: { outcome, errorCode: err.reason },
        callId: err.callId,
        costMicroUsd: err.costMicroUsd,
        // The guard's flag travels with a failure as with an answer (issue #32 item 11).
        reviewRequired: err.reviewRequired,
        guardRuleIds: err.guardRuleIds,
    };
}

/** 2.1's error → the run's named failure (the table in the header). Rethrows what is neither 2.1's nor the SDK's. */
export function reconcileOutcomeOf(err: unknown): ReconcileCallResult {
    if (err instanceof AiUnavailableError) return failed(err.reason === 'AI_DISABLED' ? 'KILL_SWITCH' : 'AI_UNAVAILABLE', err);
    if (err instanceof AiSpendCeilingError) return failed('WORKSPACE_CEILING', err);
    if (err instanceof AiGuardBlockedError) return failed('GUARD_REFUSED', err);
    if (err instanceof AiTimeoutError) return failed('TIMEOUT', err);
    if (err instanceof AiCallAbortedError) return failed('ABORTED', err);
    if (err instanceof AiProviderError) return failed('PROVIDER_FAILURE', err);
    if (err instanceof AiOutputInvalidError) return failed('INVALID_OUTPUT', err);
    if (err instanceof AiPromptError) {
        logger.error('enrichment.reconcile_prompt_invalid', { component: 'enrichment', errorCode: err.code });
        return { output: null, tokensUsed: 0, failure: { outcome: 'PROMPT_INVALID', errorCode: 'PROMPT_INVALID' } };
    }
    throw err;
}

/** A reconciler over a structured caller. */
export function reconcilerOver(call: ReconcileCaller, unavailableReason: () => string | null = () => null): Reconciler {
    return Object.freeze({
        unavailableReason,
        async reconcile(request, signal): Promise<ReconcileCallResult> {
            try {
                const result = await call({ template: request.template, data: request.data, schema: request.schema, bookId: request.bookId, signal });
                return {
                    output: result.value,
                    tokensUsed: result.tokensUsed,
                    callId: result.callId,
                    costMicroUsd: result.costMicroUsd,
                    reviewRequired: result.reviewRequired,
                    guardRuleIds: result.guardRuleIds,
                    model: modelForTier(RECONCILE_PROMPT.tier),
                };
            } catch (err) {
                return reconcileOutcomeOf(err);
            }
        },
    } satisfies Reconciler);
}

/** The deployment's reconciler: 2.1's `callStructured`, in the context's workspace, as its user. */
export function defaultReconciler(ctx: WorkspaceRequestContext): Reconciler {
    return reconcilerOver(
        (input) => callStructured(ctx, input),
        // The kill switch is a run outcome (KILL_SWITCH), not a refusal.
        () => {
            const reason = modelUnavailableReason();
            return reason === 'AI_DISABLED' ? null : reason;
        },
    );
}
