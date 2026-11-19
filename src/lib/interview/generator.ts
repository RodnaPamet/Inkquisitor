/**
 * The question engine's model step, as an interface (Phase 2.2).
 *
 * One call per persona per round (`balanced` tier) words questions for the
 * fields the plan assigned to that persona. The engine builds the whole
 * request (`buildGenerationRequest`, `prompt.ts`): a 2.1 prompt template
 * (product text only) and the author text as data blocks, which 2.1 fences.
 * A generator only sends it and returns the structured output. Whatever it
 * returns is untrusted: the engine re-parses it item by item and validates
 * every candidate in code.
 *
 * The deployment's generator comes from `defaultQuestionGenerator(ctx)` in
 * `model-seam.ts`, over 2.1's `callStructured`.
 *
 * How a call can end, and what the engine does (`produceRound`,
 * `generateClaimedRound`):
 *
 *   an answer                 `{ output, tokensUsed }`: parsed, validated
 *   a failure of THIS call     `{ output: null, tokensUsed, failure }`: its
 *                              persona's fields go to the pack fallback; the
 *                              tokens are charged; the round goes on
 *   a stop of the SESSION      `GenerationStop` thrown: the round is FAILED
 *                              and the session ends with its reason (the kill
 *                              switch, the spend ceiling, a configuration
 *                              that can make no call); nothing is asked
 */
import type { AuthorDataBlock, PromptTemplate } from '@/lib/ai/prompt';
import type { GeneratedQuestionsSchema } from './candidates';
import type { StopReason } from './vocabulary';

export interface GenerationRequest {
    /**
     * The 2.1 prompt template: id, `QUESTION_PROMPT_VERSION`, purpose, tier
     * `balanced`, the per-call output and cost budgets (rule 9), and a system
     * prompt and task of PRODUCT text only (the engine's instructions, the
     * craft and persona packs in play, the dials in words).
     */
    template: Readonly<PromptTemplate>;
    /** Every piece of author text the call carries, one labelled block each; 2.1 fences them as data. */
    data: readonly AuthorDataBlock[];
    /** The structured output's schema. Code, never built from author text. */
    schema: typeof GeneratedQuestionsSchema;
    /** The book the call is recorded against (`AiCallLog.bookId`). */
    bookId: string | null;
    /** The persona whose share of the round this call words; null when the session mounts none. */
    personaKey: string | null;
}

/**
 * Why one call produced nothing usable, named after 2.1's outcome. Each is a
 * failure of THIS call only; the session goes on.
 *
 *   GUARD           REFUSED_GUARD: author text blocked on the way in, or the
 *                   answer withheld on the way out (or a scanner failed closed)
 *   TIMEOUT         TIMEOUT: the tier's deadline passed
 *   ABORTED         ABORTED: the caller cancelled
 *   PROVIDER        PROVIDER_ERROR: the provider failed or declined, or the
 *                   request was refused on its way out
 *   INVALID_OUTPUT  INVALID_OUTPUT: still invalid after the one repair, cut
 *                   off, or no answer
 */
export const GENERATION_FAILURES = ['GUARD', 'TIMEOUT', 'ABORTED', 'PROVIDER', 'INVALID_OUTPUT'] as const;
export type GenerationFailureKind = (typeof GENERATION_FAILURES)[number];

export interface GenerationFailure {
    kind: GenerationFailureKind;
    /** 2.1's error code (`AI_ERROR_CODES`): a code, never a message. */
    errorCode: string;
}

/**
 * What one call returns: the raw output and what it cost. The cost travels
 * with the output so the session's token budget (`InterviewSession.tokensUsed`,
 * checked by `decideStop` before every round) is charged by the engine from
 * the seam alone.
 */
export interface GenerationResult {
    /** The raw structured output, parsed again by the engine (null: the call produced nothing usable). */
    output: unknown;
    /** Every token the call used, as the provider reported them (0 when none were spent). */
    tokensUsed: number;
    /** Set when the call failed; `output` is then null. */
    failure?: GenerationFailure;
    /** The call's `AiCallLog` id, when one was recorded. */
    callId?: string | null;
    /** What the call cost, in micro-dollars (0 when unknown). */
    costMicroUsd?: number;
    /** The guard flagged the input or the answer and the call went on ("flag and fence"). */
    reviewRequired?: boolean;
    /** The guard rule ids that fired (codes, never text). */
    guardRuleIds?: readonly string[];
}

/** The reasons a generation call may stop the whole session (each is in `InterviewStopReason`). */
export type GenerationStopReason = Extract<StopReason, 'KILL_SWITCH' | 'WORKSPACE_CEILING' | 'PROVIDER_FAILURE'>;

/**
 * Thrown by a generator when the SESSION must stop rather than this call
 * fail: the kill switch is on, the workspace's spend ceiling is reached, or
 * the configuration can make no call at all. The round is abandoned (nothing
 * of it is asked, nothing is faked) and the session ends with `reason`;
 * `errorCode` (2.1's) and `callId` go in its `stopDetail`.
 */
export class GenerationStop extends Error {
    constructor(
        readonly reason: GenerationStopReason,
        readonly errorCode: string,
        readonly callId: string | null,
        /** Tokens spent before the stop, this call's and (once the engine adds them) the round's. */
        readonly tokensUsed: number,
    ) {
        super(`Question generation stopped the session (${reason}, ${errorCode}).`);
        this.name = 'GenerationStop';
    }

    /** The same stop, carrying `extra` more tokens (the round's earlier calls). */
    withTokens(extra: number): GenerationStop {
        return new GenerationStop(this.reason, this.errorCode, this.callId, this.tokensUsed + extra);
    }
}

export interface QuestionGenerator {
    /**
     * Why no call can be made at all right now (2.1's configuration reasons:
     * no key, ambient SDK headers, no declared retention mode), or null. A
     * usecase asks it before it writes anything and refuses 503
     * `AI_UNAVAILABLE` naming the reason. The kill switch is not asked here:
     * it is a session stop (`modelBudgetSignals`).
     */
    unavailableReason(): string | null;
    /**
     * One call. Returns the output, or a named `failure` with the tokens it
     * spent; throws `GenerationStop` when the session must stop. Any other
     * throw is counted as a failed call.
     */
    generateCandidates(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult>;
}
