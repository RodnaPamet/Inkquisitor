/**
 * Stop precedence (implementation note, "Stop precedence"; owner decision
 * 2026-11-19): the frontier's reasons first, then 2.1's kill switch and spend
 * ceiling, then the token and round budgets. A session with nothing left to
 * ask completes saying so, whatever else holds — the kill switch included;
 * only a session that would need the model pauses for it.
 */
import type { SessionRow } from '@/app-layer/repositories/interview.repository';
import { stopNow } from '@/app-layer/usecases/interview-rounds';
import type { InterviewState } from '@/app-layer/usecases/interview-state';
import { getTemplate } from '@/lib/bible/templates';

const EL = 'el-1';

function session(over: Partial<SessionRow> = {}): SessionRow {
    return {
        id: 's1', bookId: 'b1', scope: 'ELEMENT', targetElementId: EL, targetKind: null, depth: 1, detail: 3, personaKeys: [],
        offerRecommended: true, preferChoice: false, status: 'ACTIVE', stopReason: null, stopDetail: null, roundBudget: 2, roundsRun: 0,
        tokenBudget: 30_000, tokensUsed: 0, createdById: null, createdAt: new Date(0), updatedAt: new Date(0), endedAt: null, ...over,
    };
}

function state(stored: Record<string, string>): InterviewState {
    return {
        elements: [{ elementId: EL, kind: 'THEME', name: 'Grief', customLabel: null, fields: getTemplate('THEME').fields, storedText: new Map(Object.entries(stored)) }],
        scopeTruncated: false, questions: [], latest: new Map(), answerFacts: [], promptAnswers: [], asked: [], related: [], rounds: [], challenged: [], challengesPlanned: 0,
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
