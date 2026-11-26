/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between source ingestion (4.0) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultFactExtractor(ctx)` is a `FactExtractor` over the workspace-bound
 * `callStructured` (`src/app-layer/usecases/model-calls.ts`): EXTRACT_PROMPT,
 * `FactsOutputSchema`, one call per chunk, each reserved against the monthly
 * ceiling before it is sent. Calling the model needs no permission of its own:
 * the ingestion's usecase checks that the person who started it may still
 * edit the bible (`bible.edit`).
 *
 * ── 2.1 OUTCOME → THE CHUNK ────────────────────────────────────────────────
 *
 *   OK, REPAIRED              the output, tokens, call id, cost
 *   KILLED (AI_DISABLED)      KILL_SWITCH: the ingestion stops, resumable
 *   CEILING                   WORKSPACE_CEILING: the ingestion stops CEILING, resumable
 *   by configuration          AI_UNAVAILABLE: the ingestion stops
 *   REFUSED_GUARD             GUARD_REFUSED: the chunk yields no fact (its text tripped the guard)
 *   TIMEOUT                   TIMEOUT: the chunk is left for a resume
 *   ABORTED                   ABORTED: the ingestion stops, resumable
 *   PROVIDER_ERROR            PROVIDER_FAILURE: the chunk is left for a resume
 *   INVALID_OUTPUT            INVALID_OUTPUT: the chunk is left for a resume
 *   AiPromptError             PROMPT_INVALID: `REPEATS_PROMPT` when the passage repeats a sentence of the prompt (it is
 *                             marked unreadable), otherwise logged as the programming error it is
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured } from '@/app-layer/usecases/model-calls';
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
    AiUnavailableError,
} from '@/lib/ai/errors';
import { logger } from '@/lib/observability/logger';
import type { ExtractFailure, ExtractResult, FactExtractor } from './extractor';
import { EXTRACT_PROMPT } from './prompt';
import { FactsOutputSchema } from './schema';

function failed(failure: ExtractFailure, err: AiCallError): ExtractResult {
    return { ok: false, failure, errorCode: err.reason, tokensUsed: err.tokensUsed, costMicroUsd: err.costMicroUsd, callIds: err.callId ? [err.callId] : [] };
}

/** 2.1's error → the chunk's named failure (the table above). Rethrows what is neither 2.1's nor the SDK's. */
export function extractOutcomeOf(err: unknown): ExtractResult {
    if (err instanceof AiUnavailableError) return failed(err.reason === 'AI_DISABLED' ? 'KILL_SWITCH' : 'AI_UNAVAILABLE', err);
    if (err instanceof AiSpendCeilingError) return failed('WORKSPACE_CEILING', err);
    if (err instanceof AiGuardBlockedError) return failed('GUARD_REFUSED', err);
    if (err instanceof AiTimeoutError) return failed('TIMEOUT', err);
    if (err instanceof AiCallAbortedError) return failed('ABORTED', err);
    if (err instanceof AiProviderError) return failed('PROVIDER_FAILURE', err);
    if (err instanceof AiOutputInvalidError) return failed('INVALID_OUTPUT', err);
    if (err instanceof AiPromptError) {
        // The one prompt refusal the TEXT causes (Phase 4.1, #57 item 2): a block that repeats a sentence of the
        // prompt (2.1 refuses a prompt that carries a block's text). It is named apart, so the caller can mark that
        // passage unreadable; any other is the programming error it is, logged, and left for a resume.
        const problem = (err.details as { problem?: unknown } | undefined)?.problem;
        const repeats = typeof problem === 'string' && problem.endsWith('contains author text');
        if (!repeats) logger.error('sources.prompt_invalid', { component: 'sources', errorCode: err.code });
        return { ok: false, failure: 'PROMPT_INVALID', errorCode: repeats ? 'REPEATS_PROMPT' : 'PROMPT_INVALID', tokensUsed: 0, costMicroUsd: 0, callIds: [] };
    }
    throw err;
}

/** One structured call with the workspace bound (the deployment's, or a test's over the fake Messages API). */
export type ExtractCaller = (input: Omit<StructuredCallInput<typeof FactsOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

export function extractorOver(call: ExtractCaller): FactExtractor {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await call({ template: EXTRACT_PROMPT, data: request.data, schema: FactsOutputSchema, bookId: request.bookId, signal });
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                return extractOutcomeOf(err);
            }
        },
    } satisfies FactExtractor);
}

/** The deployment's extractor, in the context's workspace, as its user. `deps` is the tests' fetch seam. */
export function defaultFactExtractor(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}): FactExtractor {
    return extractorOver((input) => callStructured(ctx, input, deps));
}
