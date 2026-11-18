/**
 * The model layer's typed errors.
 *
 * New for Inkquisitor (Phase 2.1). Each is an `AppError`, so a route wrapped in
 * `withApiErrorHandling` answers with its status and code, and each carries a
 * named `reason`. None carries author text or model output: messages are fixed
 * sentences, and `details` hold reasons, rule ids, Zod issue paths and codes.
 */
import { AppError } from '@/lib/errors/types';
import type { GuardDirection } from './guard';

/** Why the model layer cannot make any call at all. */
export type AiUnavailableReason =
    /** `AI_DISABLED=1`: the global kill switch. */
    | 'AI_DISABLED'
    /** `ANTHROPIC_API_KEY` is not configured. */
    | 'CREDENTIAL_NOT_CONFIGURED'
    /** `ANTHROPIC_CUSTOM_HEADERS` is set, and the SDK would add it to every request. */
    | 'SDK_AMBIENT_HEADERS_SET';

/** The product is running with AI off, or cannot reach the provider by configuration. 503. */
export class AiUnavailableError extends AppError {
    public readonly reason: AiUnavailableReason;
    constructor(reason: AiUnavailableReason) {
        super('AI features are not available right now.', 'AI_UNAVAILABLE', 503, true, { reason });
        this.name = 'AiUnavailableError';
        this.reason = reason;
    }
}

/** The guard refused: author text on the way in, or model output on the way out. 422. */
export class AiGuardBlockedError extends AppError {
    public readonly direction: GuardDirection;
    public readonly ruleIds: readonly string[];
    constructor(direction: GuardDirection, ruleIds: readonly string[]) {
        super(
            direction === 'input'
                ? 'The text could not be sent to the model.'
                : 'The model answer was withheld by the output guard.',
            'AI_GUARD_BLOCKED',
            422,
            true,
            { reason: direction === 'input' ? 'GUARD_BLOCKED_INPUT' : 'GUARD_BLOCKED_OUTPUT', ruleIds: [...ruleIds] },
        );
        this.name = 'AiGuardBlockedError';
        this.direction = direction;
        this.ruleIds = [...ruleIds];
    }
}

/** The scope's monthly spend ceiling would be passed by this call's worst case. 429. */
export class AiSpendCeilingError extends AppError {
    constructor(details: { spentMicroUsd: number; worstCaseMicroUsd: number; ceilingMicroUsd: number; period: string }) {
        super('The monthly AI spend limit has been reached.', 'AI_SPEND_CEILING', 429, true, {
            reason: 'SPEND_CEILING',
            ...details,
        });
        this.name = 'AiSpendCeilingError';
    }
}

/** A Zod issue reduced to what is safe to keep: where and which rule, never the value. */
export interface SafeIssue {
    readonly path: string;
    readonly code: string;
}

export type AiOutputInvalidReason =
    /** Still invalid after the one repair attempt. */
    | 'INVALID_AFTER_REPAIR'
    /** The answer was cut off at `max_tokens`; a repair would be cut off too. */
    | 'TRUNCATED';

/** The model's answer did not validate. 502. */
export class AiOutputInvalidError extends AppError {
    public readonly reason: AiOutputInvalidReason;
    public readonly issues: readonly SafeIssue[];
    constructor(reason: AiOutputInvalidReason, issues: readonly SafeIssue[]) {
        super('The model returned an answer that could not be used.', 'AI_OUTPUT_INVALID', 502, true, {
            reason,
            issues: [...issues],
        });
        this.name = 'AiOutputInvalidError';
        this.reason = reason;
        this.issues = [...issues];
    }
}

/** The model declined (`stop_reason: refusal`). 422. */
export class AiRefusedError extends AppError {
    constructor(category: string | null) {
        super('The model declined this request.', 'AI_REFUSED', 422, true, { reason: 'MODEL_REFUSED', category });
        this.name = 'AiRefusedError';
    }
}

/** The provider failed, or this process refused the request on its way out. 502. */
export class AiProviderError extends AppError {
    constructor(details: { status: number | null; reason: string }) {
        super('The model provider could not complete the request.', 'AI_PROVIDER_ERROR', 502, true, details);
        this.name = 'AiProviderError';
    }
}

/**
 * This process refused a request on its way out (`client.ts`'s messages-only
 * middleware): a programming error, never the provider's answer. 500.
 */
export class AiRequestRefusedError extends AppError {
    public readonly reason: string;
    constructor(reason: string) {
        super('A model request was refused before it was sent.', 'AI_REQUEST_REFUSED', 500, false, { reason });
        this.name = 'AiRequestRefusedError';
        this.reason = reason;
    }
}

/** The caller aborted the call (`signal`). 499 is not a standard status; 408 is the closest. */
export class AiCallAbortedError extends AppError {
    constructor() {
        super('The model call was cancelled.', 'AI_CALL_ABORTED', 408, true, { reason: 'ABORTED' });
        this.name = 'AiCallAbortedError';
    }
}
