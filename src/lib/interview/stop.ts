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
 *   6. the round budget: COMPLETES
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
    roundBudget: number;
    roundsRun: number;
}

export function decideStop(state: StopState): StopReason | null {
    if (state.frontierStop) return state.frontierStop;
    if (state.killSwitch) return 'KILL_SWITCH';
    if (state.workspaceCeilingReached) return 'WORKSPACE_CEILING';
    if (state.tokensUsed + state.nextRoundTokens > state.tokenBudget) return 'TOKEN_BUDGET';
    if (state.authorStopped) return 'AUTHOR_STOPPED';
    if (state.roundsRun >= state.roundBudget) return 'ROUND_BUDGET';
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
