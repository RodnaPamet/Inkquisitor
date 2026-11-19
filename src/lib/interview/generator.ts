/**
 * The question engine's model step, as an interface (Phase 2.2).
 *
 * One call per persona per round (`balanced` tier) words questions for the
 * fields the plan assigned to that persona. The engine builds the whole
 * request (`buildGenerationRequest`, `prompt.ts`); a generator only sends it
 * and returns the structured output. Whatever it returns is untrusted: the
 * engine re-parses it item by item and validates every candidate in code.
 *
 * The deployment's generator comes from `defaultQuestionGenerator()` in
 * `model-seam.ts`, the one place 2.1 wires in.
 */
import type { GeneratedQuestionsSchema } from './candidates';

export interface GenerationRequest {
    purpose: 'QUESTION_GENERATION';
    /** `QUESTION_PROMPT_VERSION`: recorded on the round and, by 2.1, with the call (rule 9). */
    promptVersion: string;
    tier: 'balanced';
    /** The call's output budget, from the detail dial (rule 9: a cost budget per call). */
    maxOutputTokens: number;
    /** The workspace whose spend ceiling the call counts against. */
    workspaceId: string;
    /** The persona whose share of the round this call words; null when the session mounts none. */
    personaKey: string | null;
    /** The engine's fixed instructions and the packs: product text only, never author text. */
    system: string;
    /** The fenced data (author text) and the closing restatement of the output rules. */
    user: string;
    /** The structured output's schema. */
    schema: typeof GeneratedQuestionsSchema;
}

/**
 * What one call returns: the raw output and what it cost. The cost travels
 * with the output so the session's token budget (`InterviewSession.tokensUsed`,
 * checked by `decideStop` before every round) is charged by the engine from
 * the seam alone; the wiring needs no edit outside `model-seam.ts`.
 */
export interface GenerationResult {
    /** The raw structured output, parsed again by the engine (null: the call spent tokens and produced nothing usable). */
    output: unknown;
    /** Input and output tokens the call used, as the provider reported them (0 when none were spent). */
    tokensUsed: number;
}

export interface QuestionGenerator {
    /** False until a model is wired (2.1); a usecase refuses 503 MODEL_NOT_WIRED before writing anything. */
    readonly wired: boolean;
    /**
     * One call. May throw (a provider failure that spent nothing); a call that
     * spent tokens and then failed (output that would not validate after the
     * repair attempt) returns `{ output: null, tokensUsed }` instead, so its
     * cost is charged.
     */
    generateCandidates(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult>;
}
