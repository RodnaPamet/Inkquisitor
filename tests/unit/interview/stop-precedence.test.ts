/**
 * Stop precedence (implementation note, "Stop precedence"; owner decision
 * 2026-11-19): the frontier's reasons first, then 2.1's kill switch and spend
 * ceiling, then the token and round budgets. A session with nothing left to
 * ask completes saying so, whatever else holds — the kill switch included;
 * only a session that would need the model pauses for it.
 */
import type { SessionRow } from '@/app-layer/repositories/interview.repository';
import { emptyRoundStopReason, stopNow } from '@/app-layer/usecases/interview-rounds';
import type { InterviewState } from '@/app-layer/usecases/interview-state';
import { getTemplate } from '@/lib/bible/templates';

const EL = 'el-1';

function session(over: Partial<SessionRow> = {}): SessionRow {
    return {
        id: 's1', bookId: 'b1', scope: 'ELEMENT', targetElementId: EL, targetKind: null,
        scopeElementIds: [], scopeRelationIds: [], slotKind: null, slotAfterElementId: null, slotBeforeElementId: null, slotAct: null, staleFlagId: null, stressTestId: null, depth: 1, detail: 3, personaKeys: [],
        offerRecommended: true, preferChoice: false, packPins: null, status: 'ACTIVE', stopReason: null, stopDetail: null, roundBudget: 2, roundsRun: 0,
        tokenBudget: 30_000, tokensUsed: 0, createdById: null, createdAt: new Date(0), updatedAt: new Date(0), endedAt: null, ...over,
    };
}

function state(stored: Record<string, string>): InterviewState {
    return {
        elements: [{ elementId: EL, kind: 'THEME', name: 'Grief', customLabel: null, fields: getTemplate('THEME').fields, storedText: new Map(Object.entries(stored)) }],
        checks: [], scopeTruncated: false, questions: [], latest: new Map(), answerFacts: [], promptAnswers: [], asked: [], related: [], rounds: [], challenged: [], challengesPlanned: 0,
    };
}

/** Every field of depth 1 stored: nothing left to ask. */
const allLevelOne = Object.fromEntries(getTemplate('THEME').fields.filter((f) => f.dependsOn.length === 0).map((f) => [f.key, 'stored']));

it('nothing left to ask and the token budget spent: FRONTIER_EMPTY (COMPLETED), not a TOKEN_BUDGET pause that could never resume', () => {
    expect(stopNow(session({ tokensUsed: 30_000 }), state(allLevelOne))?.reason).toMatch(/^(FRONTIER_EMPTY|NOTHING_AT_DEPTH)$/);
});

it('nothing left to ask and the rounds spent: the frontier’s reason', () => {
    expect(stopNow(session({ roundsRun: 2 }), state(allLevelOne))?.reason).toMatch(/^(FRONTIER_EMPTY|NOTHING_AT_DEPTH)$/);
});

it('something left to ask: the token budget, then the round budget, stop it', () => {
    expect(stopNow(session({ tokensUsed: 30_000 }), state({}))?.reason).toBe('TOKEN_BUDGET');
    expect(stopNow(session({ roundsRun: 2 }), state({}))?.reason).toBe('ROUND_BUDGET');
    expect(stopNow(session(), state({}))).toBeNull();
});

it('nothing left to ask FINISHES even with the kill switch on or the ceiling reached: it needs no model', () => {
    const done = stopNow(session(), state(allLevelOne), { killSwitch: true, workspaceCeilingReached: true });
    expect(done?.reason).toMatch(/^(FRONTIER_EMPTY|NOTHING_AT_DEPTH)$/);
    expect(stopNow(session(), state(allLevelOne), { killSwitch: false, workspaceCeilingReached: true })?.reason).toMatch(/^(FRONTIER_EMPTY|NOTHING_AT_DEPTH)$/);
});

it('a session that would need the model pauses: the kill switch first, then the ceiling, before any budget', () => {
    const spent = session({ tokensUsed: 30_000, roundsRun: 2 });
    expect(stopNow(spent, state({}), { killSwitch: true, workspaceCeilingReached: true })?.reason).toBe('KILL_SWITCH');
    expect(stopNow(spent, state({}), { killSwitch: false, workspaceCeilingReached: true })?.reason).toBe('WORKSPACE_CEILING');
    expect(stopNow(session(), state({}), { killSwitch: true, workspaceCeilingReached: false })?.reason).toBe('KILL_SWITCH');
});

describe('a round left with no question: why it pauses (the seam header’s table)', () => {
    const m = (generationCalls: number, generationFailures: number, failures: Record<string, number> = {}) => ({ generationCalls, generationFailures, failures });

    it('every call refused by the guard: GUARD_REFUSED', () => {
        expect(emptyRoundStopReason(m(1, 1, { GUARD: 1 }))).toBe('GUARD_REFUSED');
    });

    it('every call failed for the provider’s sake (named, or a throw the seam could not name): PROVIDER_FAILURE', () => {
        for (const kind of ['TIMEOUT', 'ABORTED', 'PROVIDER']) expect(emptyRoundStopReason(m(1, 1, { [kind]: 1 }))).toBe('PROVIDER_FAILURE');
        expect(emptyRoundStopReason(m(1, 1))).toBe('PROVIDER_FAILURE');
        expect(emptyRoundStopReason(m(2, 2, { GUARD: 1, TIMEOUT: 1 }))).toBe('PROVIDER_FAILURE');
    });

    it('the model answered, but invalidly: NO_ACCEPTABLE_QUESTION, never a provider failure', () => {
        expect(emptyRoundStopReason(m(1, 1, { INVALID_OUTPUT: 1 }))).toBe('NO_ACCEPTABLE_QUESTION');
        expect(emptyRoundStopReason(m(2, 2, { GUARD: 1, INVALID_OUTPUT: 1 }))).toBe('NO_ACCEPTABLE_QUESTION');
    });

    it('a call that answered, or no call at all: NO_ACCEPTABLE_QUESTION', () => {
        expect(emptyRoundStopReason(m(1, 0))).toBe('NO_ACCEPTABLE_QUESTION');
        expect(emptyRoundStopReason(m(2, 1, { PROVIDER: 1 }))).toBe('NO_ACCEPTABLE_QUESTION');
        expect(emptyRoundStopReason(m(0, 0))).toBe('NO_ACCEPTABLE_QUESTION');
    });
});
