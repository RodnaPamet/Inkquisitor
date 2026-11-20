/**
 * The reconcile step's model call, as an interface (Phase 2.5).
 *
 * One call per closed round (`balanced` tier) reads the round's answers and
 * the scope fields and returns proposed operations. The engine builds the
 * whole request (`buildReconcileRequest`, `prompt.ts`); a reconciler only
 * sends it and returns the raw structured output, which the engine re-parses
 * item by item and validates in code (`schema.ts`, `validate.ts`).
 *
 * The deployment's reconciler is `defaultReconciler(ctx)` (`model-seam.ts`),
 * over 2.1's `callStructured`. Tests and the evaluation hand in their own.
 *
 * Every way a call ends is a named outcome (`RECONCILE_OUTCOMES`); a failed
 * call proposes nothing (design 10.2: never from a partial output).
 */
import type { ReconcileOutcome } from './vocabulary';
import type { ReconcileRequest } from './prompt';

/** The outcomes a call itself can end in (the run adds NOTHING_TO_RECONCILE, the refusals and CLAIM_EXPIRED). */
export type ReconcileCallFailure = Extract<
    ReconcileOutcome,
    'GUARD_REFUSED' | 'TIMEOUT' | 'ABORTED' | 'PROVIDER_FAILURE' | 'INVALID_OUTPUT' | 'KILL_SWITCH' | 'WORKSPACE_CEILING' | 'PROMPT_INVALID' | 'AI_UNAVAILABLE'
>;

export interface ReconcileCallResult {
    /** The raw structured output; null when the call failed. */
    output: unknown;
    /** Tokens the call used (0 when none were spent). */
    tokensUsed: number;
    /** Set when the call failed: the run's outcome, and 2.1's error code. */
    failure?: { outcome: ReconcileCallFailure; errorCode: string };
    /** The call's AiCallLog id, when one was recorded. */
    callId?: string | null;
    /** What the call cost, in micro-dollars. */
    costMicroUsd?: number;
    /** The guard flagged an answer (or the reply) and the call went on, fenced. */
    reviewRequired?: boolean;
    /** The guard rule ids that fired (codes, never text). */
    guardRuleIds?: readonly string[];
    /** The model that answered (the evaluation record names it). */
    model?: string;
}

export interface Reconciler {
    /**
     * Why no call can be made at all under this deployment's configuration
     * (2.1's reasons: no key, ambient SDK headers, no declared retention mode),
     * or null. The kill switch is not asked here: it is a run outcome.
     */
    unavailableReason(): string | null;
    /** One call. Never throws for a model condition: every one is a named failure. */
    reconcile(request: ReconcileRequest, signal?: AbortSignal): Promise<ReconcileCallResult>;
}
