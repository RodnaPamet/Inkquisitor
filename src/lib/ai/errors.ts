/**
 * The model layer's typed errors and call outcomes (Phase 2.1).
 *
 * Each error is an `AppError`, so a route wrapped in `withApiErrorHandling`
 * answers with its status and code, and each carries a named `reason` and the
 * call's id (the `AiCallLog` row). NONE carries author text, model output or
 * a provider message: messages are fixed sentences, and `details` hold reasons,
 * rule ids, Zod issue paths and codes. A Zod issue's `message` can quote the
 * value it judged, so it is never kept (`SafeIssue`).
 */
import { AppError } from '@/lib/errors/types';
import type { GuardDirection } from './guard';

/**
 * How a call ended; one per `AiCallLog` row. ABORTED is the caller's own
 * cancellation (its `AbortSignal`), kept apart from TIMEOUT (the layer's
 * deadline) so a cancelled call never reads as a slow provider.
 */
export const AI_CALL_OUTCOMES = [
    'OK',
    'REPAIRED',
    'INVALID_OUTPUT',
    'REFUSED_GUARD',
    'CEILING',
    'KILLED',
    'PROVIDER_ERROR',
    'TIMEOUT',
    'ABORTED',
] as const;
export type AiCallOutcome = (typeof AI_CALL_OUTCOMES)[number];

/**
 * The closed vocabulary of `AiCallLog.errorCode`: why a call that did not end
 * OK ended as it did. A code, never a message.
 */
export const AI_ERROR_CODES = [
    // KILLED
    'AI_DISABLED',
    // PROVIDER_ERROR, by configuration (nothing was sent)
    'CREDENTIAL_NOT_CONFIGURED',
    'SDK_AMBIENT_HEADERS_SET',
    'ZDR_NOT_CONFIRMED',
    // PROVIDER_ERROR, from the provider or on the way to it
    'PROVIDER_HTTP_ERROR',
    'PROVIDER_CONNECTION',
    'REQUEST_REFUSED',
    'MODEL_REFUSED',
    // PROVIDER_ERROR, inside this process: a ledger failure or a bug, not the provider
    'INTERNAL_ERROR',
    // INVALID_OUTPUT
    'INVALID_AFTER_REPAIR',
    'TRUNCATED',
    'NO_OUTPUT',
    // REFUSED_GUARD
    'GUARD_BLOCKED_INPUT',
    'GUARD_BLOCKED_OUTPUT',
    // a scanner threw: the guard fails closed (nothing sent, or the answer withheld)
    'GUARD_UNAVAILABLE',
    // CEILING
    'SPEND_CEILING',
    // TIMEOUT / ABORTED
    'DEADLINE',
    'CALLER_ABORT',
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/** Why the model layer cannot make any call at all. */
export type AiUnavailableReason = 'AI_DISABLED' | 'CREDENTIAL_NOT_CONFIGURED' | 'SDK_AMBIENT_HEADERS_SET' | 'ZDR_NOT_CONFIRMED';

/** The base of every model-layer error: an `AppError` with a reason and the call's id. */
export abstract class AiCallError extends AppError {
    public readonly reason: AiErrorCode;
    public readonly callId: string | null;
    protected constructor(
        message: string,
        code: string,
        status: number,
        reason: AiErrorCode,
        callId: string | null,
        extra: Record<string, unknown> = {},
    ) {
        super(message, code, status, true, { reason, callId, ...extra });
        this.reason = reason;
        this.callId = callId;
    }
}

/** AI is off (the kill switch) or unreachable by configuration. Nothing was sent. 503. */
export class AiUnavailableError extends AiCallError {
    constructor(reason: AiUnavailableReason, callId: string | null = null) {
        super('AI features are not available right now.', 'AI_UNAVAILABLE', 503, reason, callId);
        this.name = 'AiUnavailableError';
    }
}

/**
 * The guard refused: author text on the way in, or the model's answer on the
 * way out. 422. `unavailable`: a scanner threw, and the guard failed closed
 * (reason GUARD_UNAVAILABLE, no rule ids).
 */
export class AiGuardBlockedError extends AiCallError {
    public readonly direction: GuardDirection;
    public readonly ruleIds: readonly string[];
    constructor(direction: GuardDirection, ruleIds: readonly string[], callId: string | null, unavailable = false) {
        super(
            direction === 'input' ? 'The text could not be sent to the model.' : 'The model answer was withheld by the output guard.',
            'AI_GUARD_BLOCKED',
            422,
            unavailable ? 'GUARD_UNAVAILABLE' : direction === 'input' ? 'GUARD_BLOCKED_INPUT' : 'GUARD_BLOCKED_OUTPUT',
            callId,
            { ruleIds: [...ruleIds] },
        );
        this.name = 'AiGuardBlockedError';
        this.direction = direction;
        this.ruleIds = [...ruleIds];
    }
}

/** The workspace's monthly spend ceiling would be passed by this call's worst case. Nothing was sent. 429. */
export class AiSpendCeilingError extends AiCallError {
    constructor(
        details: { spentMicroUsd: number; reservedMicroUsd: number; worstCaseMicroUsd: number; ceilingMicroUsd: number; period: string },
        callId: string | null,
    ) {
        super('The monthly AI spend limit for this workspace has been reached.', 'AI_SPEND_CEILING', 429, 'SPEND_CEILING', callId, details);
        this.name = 'AiSpendCeilingError';
    }
}

/** A Zod issue reduced to what is safe to keep: where and which rule, never the value or the message. */
export interface SafeIssue {
    readonly path: string;
    readonly code: string;
}

/** The model's answer could not be used: still invalid after the one repair, cut off, or absent. 502. */
export class AiOutputInvalidError extends AiCallError {
    public readonly issues: readonly SafeIssue[];
    constructor(reason: 'INVALID_AFTER_REPAIR' | 'TRUNCATED' | 'NO_OUTPUT', issues: readonly SafeIssue[], callId: string | null) {
        super('The model returned an answer that could not be used.', 'AI_OUTPUT_INVALID', 502, reason, callId, {
            issues: [...issues],
        });
        this.name = 'AiOutputInvalidError';
        this.issues = [...issues];
    }
}

/** The provider failed, the model declined, or this process refused the request on its way out. 502. */
export class AiProviderError extends AiCallError {
    constructor(
        reason: 'PROVIDER_HTTP_ERROR' | 'PROVIDER_CONNECTION' | 'REQUEST_REFUSED' | 'MODEL_REFUSED',
        callId: string | null,
        extra: { status?: number | null; type?: string | null; category?: string | null } = {},
    ) {
        super('The model provider could not complete the request.', 'AI_PROVIDER_ERROR', 502, reason, callId, extra);
        this.name = 'AiProviderError';
    }
}

/** The call passed its tier's deadline and was aborted. 504. */
export class AiTimeoutError extends AiCallError {
    constructor(callId: string | null) {
        super('The model took too long to answer.', 'AI_TIMEOUT', 504, 'DEADLINE', callId);
        this.name = 'AiTimeoutError';
    }
}

/** The caller cancelled the call (its `AbortSignal`). 408, the closest standard status. */
export class AiCallAbortedError extends AiCallError {
    constructor(callId: string | null) {
        super('The model call was cancelled.', 'AI_CALL_ABORTED', 408, 'CALLER_ABORT', callId);
        this.name = 'AiCallAbortedError';
    }
}

/**
 * This process refused a request on its way out (`./client.ts`'s
 * messages-only middleware). A programming error, never the provider's
 * answer; `callStructured` reports it as `AiProviderError` REQUEST_REFUSED.
 */
export class AiRequestRefusedError extends Error {
    public readonly refusal: string;
    constructor(refusal: string) {
        super(`A model request was refused before it was sent (${refusal}).`);
        this.name = 'AiRequestRefusedError';
        this.refusal = refusal;
    }
}

/**
 * A prompt was built wrongly: a malformed template or label, or author text
 * found in the system prompt. A programming error, thrown before anything is
 * reserved or sent. 500, not exposed.
 */
export class AiPromptError extends AppError {
    constructor(problem: string) {
        super('A model prompt could not be built.', 'AI_PROMPT_INVALID', 500, false, { problem });
        this.name = 'AiPromptError';
    }
}
