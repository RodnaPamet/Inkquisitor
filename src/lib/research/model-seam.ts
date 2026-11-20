/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between the research run (2.6) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultResearcher(ctx)` is a `Researcher` (`./researcher.ts`) over the
 * workspace-bound model calls of `src/app-layer/usecases/model-calls.ts`:
 *
 *   gather    `runServerToolLoop`: GATHER_PROMPT, the web search and web fetch
 *             server tools (the two types `PERMITTED_SERVER_TOOL_TYPES`
 *             allows), the depth's caps, the egress tripwire; one AiCallLog
 *             row per request, each reserved against the monthly ceiling
 *   findings  `callStructured`: FINDINGS_PROMPT, `FindingsOutputSchema`
 *   fit       `callStructured`: FIT_PROMPT, `FitOutputSchema`
 *
 * Calling the model needs no permission of its own: the run's usecase checks
 * that the person who dispatched it may still edit the bible (`bible.edit`).
 *
 * ── 2.1 OUTCOME → THE RUN ──────────────────────────────────────────────────
 *
 *   OK, REPAIRED              the output, tokens, call ids, cost, the guard's flag
 *   KILLED (AI_DISABLED)      KILL_SWITCH: nothing more was sent
 *   CEILING                   WORKSPACE_CEILING: nothing more was sent
 *   by configuration          AI_UNAVAILABLE (normally unreachable: the run asks first)
 *   REFUSED_GUARD             GUARD_REFUSED
 *   TOOL_USE_REFUSED          QUERY_REFUSED: a query or URL quoted the book's text
 *   TIMEOUT                   TIMEOUT
 *   ABORTED                   ABORTED
 *   PROVIDER_ERROR            PROVIDER_FAILURE
 *   INVALID_OUTPUT            INVALID_OUTPUT
 *   AiPromptError             PROMPT_INVALID, logged as the programming error it is
 *
 * Tokens and cost travel with a failure as with an answer.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured, runServerToolLoop } from '@/app-layer/usecases/model-calls';
import type { StructuredCallDeps, StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import {
    AiCallAbortedError,
    AiCallError,
    AiGuardBlockedError,
    AiOutputInvalidError,
    AiPromptError,
    AiProviderError,
    AiSpendCeilingError,
    AiTimeoutError,
    AiToolUseRefusedError,
    AiUnavailableError,
} from '@/lib/ai/errors';
import { logger } from '@/lib/observability/logger';
import { FINDINGS_PROMPT, FIT_PROMPT, GATHER_PROMPT } from './prompt';
import type { Researcher, StepCost, StepFailure, StepResult } from './researcher';
import { FindingsOutputSchema, FitOutputSchema } from './schema';

export type ResearchFailure = { ok: false; failure: StepFailure; errorCode: string } & StepCost;

function failed(failure: StepFailure, err: AiCallError): ResearchFailure {
    return {
        ok: false,
        failure,
        errorCode: err.reason,
        tokensUsed: err.tokensUsed,
        costMicroUsd: err.costMicroUsd,
        callIds: err.callId ? [err.callId] : [],
        // The guard's flag travels with a failure as with an answer (issue #32 item 11).
        reviewRequired: err.reviewRequired,
        guardRuleIds: err.guardRuleIds,
    };
}

/** 2.1's error → the run's named failure (the table above). Rethrows what is neither 2.1's nor the SDK's. */
export function researchOutcomeOf(err: unknown): ResearchFailure {
    if (err instanceof AiUnavailableError) return failed(err.reason === 'AI_DISABLED' ? 'KILL_SWITCH' : 'AI_UNAVAILABLE', err);
    if (err instanceof AiSpendCeilingError) return failed('WORKSPACE_CEILING', err);
    if (err instanceof AiToolUseRefusedError) return failed('QUERY_REFUSED', err);
    if (err instanceof AiGuardBlockedError) return failed('GUARD_REFUSED', err);
    if (err instanceof AiTimeoutError) return failed('TIMEOUT', err);
    if (err instanceof AiCallAbortedError) return failed('ABORTED', err);
    if (err instanceof AiProviderError) return failed('PROVIDER_FAILURE', err);
    if (err instanceof AiOutputInvalidError) return failed('INVALID_OUTPUT', err);
    if (err instanceof AiPromptError) {
        logger.error('research.prompt_invalid', { component: 'research', errorCode: err.code });
        return { ok: false, failure: 'PROMPT_INVALID', errorCode: 'PROMPT_INVALID', tokensUsed: 0, costMicroUsd: 0, callIds: [] };
    }
    throw err;
}

/** One structured call with the workspace bound (the deployment's, or a test's over the fake Messages API). */
export type ResearchCaller = (input: Omit<StructuredCallInput<typeof FindingsOutputSchema | typeof FitOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

/** The research run's two structured steps over a structured caller (the injection suite drives them over the fake API). */
export function researchStepsOver(call: ResearchCaller): Pick<Researcher, 'findings' | 'fit'> {
    const structured = async (template: typeof FINDINGS_PROMPT, schema: typeof FindingsOutputSchema | typeof FitOutputSchema, request: { data: Parameters<Researcher['findings']>[0]['data']; bookId: string }, signal?: AbortSignal): Promise<StepResult<unknown>> => {
        try {
            const r = await call({ template, data: request.data, schema, bookId: request.bookId, signal });
            return { ok: true, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId], reviewRequired: r.reviewRequired, guardRuleIds: r.guardRuleIds };
        } catch (err) {
            return researchOutcomeOf(err);
        }
    };
    return {
        findings: (request, signal) => structured(FINDINGS_PROMPT, FindingsOutputSchema, request, signal),
        fit: (request, signal) => structured(FIT_PROMPT, FitOutputSchema, request, signal),
    };
}

/** The deployment's researcher, in the context's workspace, as its user. `deps` is the tests' fetch seam. */
export function defaultResearcher(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}): Researcher {
    const steps = researchStepsOver((input) => callStructured(ctx, input, deps));
    return Object.freeze({
        async gather(request, observer, signal) {
            try {
                const r = await runServerToolLoop(
                    ctx,
                    {
                        template: GATHER_PROMPT,
                        data: request.data,
                        tools: request.tools,
                        maxRequests: request.maxRequests,
                        budgetMicroUsd: request.budgetMicroUsd,
                        inspectToolUse: request.inspectToolUse,
                        bookId: request.bookId,
                        signal,
                        onEvent: (e) => {
                            if (e.type === 'tool_use') observer.onToolUse?.({ searches: e.searches, fetches: e.fetches });
                        },
                    },
                    deps,
                );
                return {
                    ok: true as const,
                    output: {
                        stop: r.stop,
                        searches: r.searches,
                        fetches: r.fetches,
                        requests: r.requests,
                        tokensUsed: r.tokensUsed,
                        costMicroUsd: r.costMicroUsd,
                        callIds: r.callIds,
                        reviewRequired: r.reviewRequired,
                        guardRuleIds: r.guardRuleIds,
                    },
                };
            } catch (err) {
                return researchOutcomeOf(err);
            }
        },
        findings: steps.findings,
        fit: steps.fit,
    } satisfies Researcher);
}
