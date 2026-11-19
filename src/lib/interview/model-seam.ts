/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between the question engine (2.2) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * Phase 2.2 was built beside 2.1, not on it, so the model step of the
 * question engine stands behind the `QuestionGenerator` interface and calls
 * no model SDK. This file is the ONE place 2.1 plugs in. Wiring it is three
 * edits, all here and nowhere else:
 *
 *   1. `fenceData` — replace the placeholder body with 2.1's `fenceData`
 *      (the guard-scanned data fence). Every piece of author text the
 *      generation prompt carries goes through this function
 *      (`src/lib/interview/prompt.ts`), and none of it reaches the system
 *      prompt.
 *
 *   2. `defaultQuestionGenerator` — return a generator whose
 *      `generateCandidates(request)` is
 *
 *          callStructured(request.schema, {
 *              system: request.system,
 *              messages: [{ role: 'user', content: request.user }],
 *          }, {
 *              tier: request.tier,                    // 'balanced'
 *              purpose: request.purpose,              // 'QUESTION_GENERATION', for AiCallLog
 *              promptVersion: request.promptVersion,  // recorded with the call (rule 9)
 *              maxOutputTokens: request.maxOutputTokens,
 *              workspaceId: request.workspaceId,      // the spend ceiling's
 *          })
 *
 *      with `wired: true`. Its result is parsed again by the engine
 *      (`parseGeneratedQuestions`), item by item, whatever the seam returns.
 *
 *   3. `modelBudgetSignals` — return 2.1's global kill switch and whether the
 *      workspace's monthly spend ceiling would be passed by another round.
 *      The round step reads them before it claims a round (`claimRound` in
 *      `src/app-layer/usecases/interview-rounds.ts`), and `decideStop`
 *      checks them first, pausing the session with KILL_SWITCH or
 *      WORKSPACE_CEILING.
 *
 * Until then `defaultQuestionGenerator()` is NOT WIRED: every usecase that
 * would generate questions asks `generator.wired` before it writes anything
 * and answers 503 `MODEL_NOT_WIRED`. Nothing fakes model output in a
 * deployment; tests inject a deterministic generator through the usecases'
 * `deps` argument (or mock this module).
 */
import type { QuestionGenerator } from './generator';

/**
 * PLACEHOLDER — replace with 2.1's `fenceData` at wiring.
 *
 * Fences one piece of untrusted text as DATA: a labelled block whose content
 * is JSON-escaped and whose `<` is escaped too, so the content can neither
 * close the block nor open a tag the prompt's own instructions use.
 */
export function fenceData(label: string, content: string): string {
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, '');
    const body = JSON.stringify(content).replace(/</g, '\\u003c');
    return `<data name="${safeLabel}">\n${body}\n</data>`;
}

/** Thrown by the generator that is not wired; the usecases answer it 503 `MODEL_NOT_WIRED`. */
export class ModelNotWiredError extends Error {
    readonly reason = 'MODEL_NOT_WIRED';
    constructor() {
        super('The question generator is not wired to a model yet (Phase 2.1).');
        this.name = 'ModelNotWiredError';
    }
}

const NOT_WIRED: QuestionGenerator = Object.freeze({
    wired: false,
    async generateCandidates(): Promise<never> {
        throw new ModelNotWiredError();
    },
});

/** The deployment's question generator. Not wired until 2.1 (see the header). */
export function defaultQuestionGenerator(): QuestionGenerator {
    return NOT_WIRED;
}

/** 2.1's stop signals for a workspace (see the header). Placeholder: neither applies before 2.1. */
export async function modelBudgetSignals(workspaceId: string): Promise<{ killSwitch: boolean; workspaceCeilingReached: boolean }> {
    void workspaceId;
    return { killSwitch: false, workspaceCeilingReached: false };
}
