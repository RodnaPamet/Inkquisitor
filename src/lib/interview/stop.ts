/**
 * When a session stops, and how much of it is done (Phase 2.2; design 4.1,
 * 10.1). Pure.
 *
 * `decideStop` runs before a round is planned and checks, in this order: the
 * kill switch, the workspace's spend ceiling, the session's token budget, an
 * author's stop, the round budget. The first three are 2.1's signals (its
 * kill switch and ceiling; its token counts on the session), passed in so the
 * order is fixed here once. The frontier's own stops (FRONTIER_EMPTY,
 * NOTHING_AT_DEPTH) need the computed frontier; `stopNow`
 * (`src/app-layer/usecases/interview-rounds.ts`) puts them after the kill
 * switch and the ceiling and BEFORE the token and round budgets, so a session
 * with nothing left to ask completes saying so rather than pausing on a spent
 * budget it could never resume from.
 *
 * `sessionProgress` is the session's figure, and rule 6 holds it: a session
 * that asked nothing is NOT ASSESSED, never 0 % and never 100 %.
 */
import type { AnswerStatus, StopReason } from './vocabulary';

export interface StopState {
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
