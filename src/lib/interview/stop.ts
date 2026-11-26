/**
 * When a session stops, and how much of it is done (Phase 2.2; design 4.1,
 * 10.1). Pure.
 *
 * `decideStop` is THE precedence, decided once here (owner decision
 * 2026-11-19 on the kill switch):
 *
 *   1. the frontier's own stop (FRONTIER_EMPTY, NOTHING_AT_DEPTH): a session
 *      with nothing left to ask FINISHES, saying so, whatever else holds —
 *      the kill switch, the ceiling or a spent budget included. Finishing
 *      needs no model, and pausing it would leave a session that could never
 *      resume into anything (its tokens only grow; the switch would only let
 *      it find out it is done)
 *   2. the kill switch (2.1's `AI_DISABLED=1`): a session that would need the
 *      model PAUSES
 *   3. the workspace's monthly spend ceiling (2.1's ledger): PAUSES
 *   4. the session's token budget: PAUSES
 *   5. the author's stop
 *   6. the session's length (Phase 4.4, D23): a ROUNDS session's rounds (ROUND_BUDGET), a QUESTIONS session's
 *      questions (QUESTION_BUDGET), and for every session the most questions its reads hold (SESSION_LIMIT): each
 *      COMPLETES. An UNTIL_STOPPED session has neither of the first two
 *   7. AWAITING_DECISIONS (Phase 4.4, owner decision 2026-11-26): nothing can be asked now, but questions wait on
 *      fields whose proposed change the author has not decided: the session PAUSES until they decide (the next round
 *      resumes it), rather than finishing with follow-ups still to ask
 *   8. VALUE_FELL (Phase 4.4, D30): every question left is minor, so rather than pad a round the session PAUSES
 *      and asks the author whether to go on (once they say go on, it is not asked again). Last: it only ever
 *      replaces a round that would otherwise be generated
 *
 * The frontier's stop needs the computed frontier, so the caller passes it in
 * (`stopNow`, `src/app-layer/usecases/interview-rounds.ts`); the 2.1 signals
 * come from `modelBudgetSignals` (`model-seam.ts`).
 *
 * `sessionProgress` is the session's figure, and rule 6 holds it: a session
 * that asked nothing is NOT ASSESSED, never 0 % and never 100 %.
 */
import type { AnswerStatus, StopReason } from './vocabulary';

export interface StopState {
    /** The frontier's own stop for this session (nothing left to ask), if any. Checked first. */
    frontierStop?: StopReason | null;
    /** 2.1's global kill switch is on. */
    killSwitch?: boolean;
    /** 2.1 says the workspace's monthly spend ceiling would be passed by the next call. */
    workspaceCeilingReached?: boolean;
    tokenBudget: number;
    tokensUsed: number;
    /** What the next round is expected to spend; it is not started past the budget. */
    nextRoundTokens: number;
    authorStopped: boolean;
    /** A ROUNDS session's rounds; null for a QUESTIONS or open-ended session (Phase 4.4). */
    roundBudget: number | null;
    roundsRun: number;
    /** Phase 4.4: a QUESTIONS session's questions, and the questions it has asked. */
    questionBudget?: number | null;
    questionsAsked?: number;
    /** Phase 4.4: one more round could hold more questions than the session's reads hold. */
    sessionLimitReached?: boolean;
    /** Phase 4.4 (owner decision 2026-11-26): nothing is chosen, and some candidates wait on a pending proposal's decision. */
    awaitingDecisions?: boolean;
    /** Phase 4.4 (D30): every candidate left is minor, and the author has not chosen to go on. */
    valueFell?: boolean;
}

export function decideStop(state: StopState): StopReason | null {
    if (state.frontierStop) return state.frontierStop;
    if (state.killSwitch) return 'KILL_SWITCH';
    if (state.workspaceCeilingReached) return 'WORKSPACE_CEILING';
    if (state.tokensUsed + state.nextRoundTokens > state.tokenBudget) return 'TOKEN_BUDGET';
    if (state.authorStopped) return 'AUTHOR_STOPPED';
    if (state.roundBudget !== null && state.roundsRun >= state.roundBudget) return 'ROUND_BUDGET';
    if (state.questionBudget !== null && state.questionBudget !== undefined && (state.questionsAsked ?? 0) >= state.questionBudget) return 'QUESTION_BUDGET';
    if (state.sessionLimitReached) return 'SESSION_LIMIT';
    if (state.awaitingDecisions) return 'AWAITING_DECISIONS';
    if (state.valueFell) return 'VALUE_FELL';
    return null;
}

export type SessionProgress =
    | { status: 'NOT_ASSESSED'; asked: 0 }
    | { status: 'MEASURED'; asked: number; answered: number; skipped: number; deferred: number; unanswered: number; answeredShare: number };

/** The session's figure over the questions it asked (the latest answer of each). */
export function sessionProgress(questions: ReadonlyArray<{ status: AnswerStatus | null }>): SessionProgress {
    if (questions.length === 0) return { status: 'NOT_ASSESSED', asked: 0 };
    const count = (s: AnswerStatus | null) => questions.filter((q) => q.status === s).length;
    const answered = count('ANSWERED');
    return {
        status: 'MEASURED',
        asked: questions.length,
        answered,
        skipped: count('SKIPPED'),
        deferred: count('DECIDE_LATER'),
        unanswered: count(null),
        answeredShare: answered / questions.length,
    };
}
