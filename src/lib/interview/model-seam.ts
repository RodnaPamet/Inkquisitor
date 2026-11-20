/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between the question engine (2.2) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * The question engine's model step stands behind the `QuestionGenerator`
 * interface (`./generator.ts`); this file is the one place it meets 2.1.
 *
 *   `defaultQuestionGenerator(ctx)`  a generator over 2.1's
 *        `callStructured(ctx, { template, data, schema, bookId, signal })`
 *        (`src/app-layer/usecases/model-calls.ts`): the request's template
 *        (`QUESTION_PROMPT` plus the round's product guidance, `./prompt.ts`),
 *        its author text as data blocks (2.1 fences and guard-scans them), the
 *        strict output schema. Every call is recorded in `AiCallLog` and held to
 *        the workspace's spend ceiling by 2.1. It returns `{ output,
 *        tokensUsed }` with the call's real token usage, or a named failure,
 *        or throws `GenerationStop` (the mapping below).
 *   `modelBudgetSignals(db, ctx, detail)`  2.1's kill switch and whether the
 *        workspace's month can take one more question call; `stopNow` reads
 *        them before a round is claimed.
 *
 * Calling the model needs no permission of its own: the interview's usecases
 * check `bible.edit` before they reach here (issue #30, item 1, 2026-11-19).
 *
 * ── 2.1 OUTCOME → THE ENGINE ────────────────────────────────────────────────
 *
 *   OK, REPAIRED            the output, the tokens, the call id and cost, the
 *                           guard's flag (`reviewRequired`: the call went on,
 *                           fenced; counted on the round as guardFlaggedCalls)
 *   KILLED (AI_DISABLED)    GenerationStop KILL_SWITCH: the round is abandoned
 *                           and the session PAUSED
 *   CEILING (SPEND_CEILING) GenerationStop WORKSPACE_CEILING: abandoned, PAUSED
 *   PROVIDER_ERROR by configuration (CREDENTIAL_NOT_CONFIGURED,
 *     SDK_AMBIENT_HEADERS_SET, RETENTION_MODE_UNDECLARED; nothing was sent)
 *                           GenerationStop PROVIDER_FAILURE, the code in
 *                           `stopDetail`. Normally unreachable: the usecase
 *                           asks `unavailableReason()` first and refuses 503
 *                           AI_UNAVAILABLE before writing anything
 *   REFUSED_GUARD           failure GUARD: this call's fields go to the pack
 *                           fallback; a round left with no question PAUSES the
 *                           session GUARD_REFUSED when every call was refused
 *   TIMEOUT                 failure TIMEOUT        ┐ this call's fields go to
 *   ABORTED                 failure ABORTED        │ the pack fallback; a round
 *   PROVIDER_ERROR (HTTP, connection, model       │ left with no question
 *     refusal, request refused on the way out)    │ PAUSES the session
 *                           failure PROVIDER       ┘ PROVIDER_FAILURE
 *   INVALID_OUTPUT          failure INVALID_OUTPUT: tokens charged, nothing
 *                           used; a round left with no question PAUSES the
 *                           session NO_ACCEPTABLE_QUESTION
 *   a prompt 2.1 refuses to build (`AiPromptError`: author text in the system
 *     prompt, an output schema the API cannot take) — a programming error
 *                           logged as one, then GenerationStop PROVIDER_FAILURE
 *                           PROMPT_INVALID: never a 500, never fake output
 *
 * Tokens are charged to the session on every path, and a failed call's cost
 * counts in the round's money and its per-call budget tally (rule 9) like an
 * answered one's: both are on 2.1's error (`AiCallError.tokensUsed`,
 * `.costMicroUsd`).
 */
import type { z } from 'zod';

import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured, modelBudgetState, modelUnavailableReason, type ModelBudgetState } from '@/app-layer/usecases/model-calls';
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
import { worstCaseCostMicroUsd } from '@/lib/ai/pricing';
import { INPUT_TOKEN_OVERHEAD } from '@/lib/ai/prompt';
import { modelForTier } from '@/lib/ai/tiers';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import type { GeneratedQuestionsSchema } from './candidates';
import { GenerationStop, type GenerationFailureKind, type GenerationResult, type QuestionGenerator } from './generator';
import { maxOutputTokensFor, QUESTION_PROMPT } from './prompt';
import { REPHRASE_PROMPT } from './rephrase';

type Schema = typeof GeneratedQuestionsSchema;

/** One structured call, as the generator needs it: 2.1's `callStructured` with the workspace already bound. */
export type StructuredCaller = (input: Omit<StructuredCallInput<Schema>, 'requestedById'>) => Promise<StructuredCallResult<z.infer<Schema>>>;

function failed(kind: GenerationFailureKind, err: AiCallError): GenerationResult {
    return { output: null, tokensUsed: err.tokensUsed, failure: { kind, errorCode: err.reason }, callId: err.callId, costMicroUsd: err.costMicroUsd };
}

/** 2.1's error → the engine's failure or stop (the table in the header). Rethrows what is neither. */
export function generationOutcomeOf(err: unknown): GenerationResult {
    if (err instanceof AiUnavailableError) {
        throw new GenerationStop(err.reason === 'AI_DISABLED' ? 'KILL_SWITCH' : 'PROVIDER_FAILURE', err.reason, err.callId, err.tokensUsed);
    }
    if (err instanceof AiSpendCeilingError) throw new GenerationStop('WORKSPACE_CEILING', err.reason, err.callId, err.tokensUsed);
    if (err instanceof AiGuardBlockedError) return failed('GUARD', err);
    if (err instanceof AiTimeoutError) return failed('TIMEOUT', err);
    if (err instanceof AiCallAbortedError) return failed('ABORTED', err);
    if (err instanceof AiProviderError) return failed('PROVIDER', err);
    if (err instanceof AiOutputInvalidError) return failed('INVALID_OUTPUT', err);
    if (err instanceof AiPromptError) {
        // A programming error (a prompt 2.1 will not build), so loud — but the
        // author's session pauses with a named reason rather than a 500.
        logger.error('interview.question_prompt_invalid', { component: 'interview', errorCode: err.code });
        throw new GenerationStop('PROVIDER_FAILURE', 'PROMPT_INVALID', null, 0);
    }
    throw err;
}

/** A question generator over a structured caller (the deployment's, or a test's over the fake Messages API). */
export function questionGeneratorOver(call: StructuredCaller, unavailableReason: () => string | null = () => null): QuestionGenerator {
    return Object.freeze({
        unavailableReason,
        async generateCandidates(request, signal): Promise<GenerationResult> {
            try {
                const result = await call({ template: request.template, data: request.data, schema: request.schema, bookId: request.bookId, signal });
                return {
                    output: result.value,
                    tokensUsed: result.tokensUsed,
                    callId: result.callId,
                    costMicroUsd: result.costMicroUsd,
                    reviewRequired: result.reviewRequired,
                    guardRuleIds: result.guardRuleIds,
                };
            } catch (err) {
                return generationOutcomeOf(err);
            }
        },
    } satisfies QuestionGenerator);
}

/** The deployment's question generator: 2.1's `callStructured`, in the context's workspace, as its user. */
export function defaultQuestionGenerator(ctx: WorkspaceRequestContext): QuestionGenerator {
    return questionGeneratorOver(
        (input) => callStructured(ctx, input),
        // The kill switch is a session stop (`modelBudgetSignals`), not a refusal.
        () => {
            const reason = modelUnavailableReason();
            return reason === 'AI_DISABLED' ? null : reason;
        },
    );
}

/**
 * The least a question call at this detail can reserve: the template's own
 * system prompt and task (UTF-8 bytes), the request framing, no data, and the
 * call's whole output budget, at the balanced tier's model's dearest rates. A
 * workspace whose month cannot take even that has reached its ceiling; one that
 * can is let through, and 2.1 reserves the call's real worst case under its
 * lock (refusing CEILING when it does not fit).
 */
export function minimumQuestionCallMicroUsd(detail: number): number {
    const fixedBytes = Buffer.byteLength(QUESTION_PROMPT.system, 'utf8') + Buffer.byteLength(QUESTION_PROMPT.task, 'utf8');
    return worstCaseCostMicroUsd(modelForTier(QUESTION_PROMPT.tier), {
        inputTokens: INPUT_TOKEN_OVERHEAD + fixedBytes,
        outputTokens: maxOutputTokensFor(detail),
    });
}

/**
 * The least a rephrase call can reserve (Phase 2.4): its template's fixed text,
 * the framing and its whole output budget, at the fast tier's dearest rates.
 */
export function minimumRephraseCallMicroUsd(): number {
    const fixedBytes = Buffer.byteLength(REPHRASE_PROMPT.system, 'utf8') + Buffer.byteLength(REPHRASE_PROMPT.task, 'utf8');
    return worstCaseCostMicroUsd(modelForTier(REPHRASE_PROMPT.tier), {
        inputTokens: INPUT_TOKEN_OVERHEAD + fixedBytes,
        outputTokens: REPHRASE_PROMPT.maxOutputTokens ?? 0,
    });
}

/** 2.1's stop signals for a rephrase: the kill switch, and whether the month can take one more rephrase call. */
export async function rephraseBudgetSignals(db: PrismaTx, ctx: Pick<WorkspaceRequestContext, 'workspaceId'>): Promise<ModelBudgetState> {
    return modelBudgetState(db, ctx, minimumRephraseCallMicroUsd());
}

/** 2.1's stop signals for a workspace: the kill switch, and whether its month can take one more question call. */
export async function modelBudgetSignals(db: PrismaTx, ctx: Pick<WorkspaceRequestContext, 'workspaceId'>, detail: number): Promise<ModelBudgetState> {
    return modelBudgetState(db, ctx, minimumQuestionCallMicroUsd(detail));
}
