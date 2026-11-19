/**
 * Round planning (design 4.2), stop decisions (design 4.1, 10.1) and the
 * session's progress figure (rule 6). Pure.
 */
import { DETAIL, DEPTH, roundBudgetFor, tokenBudgetFor } from '@/lib/interview/dials';
import type { FrontierEntry } from '@/lib/interview/frontier';
import { CHALLENGES_PER_SESSION, challengeAllowed, planRound, type PlanInput } from '@/lib/interview/plan';
import { decideStop, sessionProgress, type StopState } from '@/lib/interview/stop';
import { INTERVIEW_STATUSES, STATUS_AFTER_STOP, STOP_REASONS } from '@/lib/interview/vocabulary';

const entry = (fieldKey: string, i = 0): FrontierEntry => ({ elementId: `e${i}`, fieldKey, kind: 'CHARACTER', level: 1, required: true });
const frontierOf = (n: number) => Array.from({ length: n }, (_, i) => entry(`k${i}`));

function plan(over: Partial<PlanInput>) {
    return planRound({ frontier: [], challengeable: [], challenged: [], challengesPlanned: 0, depth: 3, detail: 3, personaKeys: [], roundNumber: 1, ...over });
}

describe('targets and the round cap', () => {
    it.each(Object.entries(DETAIL).map(([d, row]) => [Number(d), row.roundCap]))('detail %i holds at most %i questions; the rest lead the next round', (detail, cap) => {
        const p = plan({ detail, frontier: frontierOf(cap + 2) });
        expect(p.targets).toHaveLength(cap);
        expect(p.carried.map((c) => c.fieldKey)).toEqual([`k${cap}`, `k${cap + 1}`]);
        expect(p.targets.map((t) => t.fieldKey)).toEqual(frontierOf(cap).map((f) => f.fieldKey));
    });
});

describe('persona assignment', () => {
    it('with no persona every target is the session’s own (null)', () => {
        expect(plan({ frontier: frontierOf(3) }).targets.map((t) => t.personaKey)).toEqual([null, null, null]);
    });

    it('with one persona every target is its', () => {
        expect(plan({ frontier: frontierOf(3), personaKeys: ['socratic'] }).targets.every((t) => t.personaKey === 'socratic')).toBe(true);
    });

    it('with several, targets are dealt round-robin, each field once, the lead rotating by round', () => {
        const personas = ['socratic', 'gentle-mentor', 'ruthless-editor'];
        const r1 = plan({ frontier: frontierOf(5), personaKeys: personas, roundNumber: 1 }).targets.map((t) => t.personaKey);
        const r2 = plan({ frontier: frontierOf(5), personaKeys: personas, roundNumber: 2 }).targets.map((t) => t.personaKey);
        expect(r1).toEqual(['socratic', 'gentle-mentor', 'ruthless-editor', 'socratic', 'gentle-mentor']);
        expect(r2).toEqual(['gentle-mentor', 'ruthless-editor', 'socratic', 'gentle-mentor', 'ruthless-editor']);
        // Deterministic.
        expect(plan({ frontier: frontierOf(5), personaKeys: personas, roundNumber: 1 }).targets.map((t) => t.personaKey)).toEqual(r1);
    });
});

describe('challenges', () => {
    const stored = [{ elementId: 'e0', fieldKey: 'role', level: 1 }, { elementId: 'e0', fieldKey: 'want', level: 2 }];

    it('allowed when the frontier is short at depth 4 or 5, or empty at depth 5 — never otherwise', () => {
        expect(challengeAllowed(1, 6, 4)).toBe(true);
        expect(challengeAllowed(6, 6, 5)).toBe(false);
        expect(challengeAllowed(0, 6, 5)).toBe(true);
        expect(challengeAllowed(0, 6, 3)).toBe(false);
        expect(challengeAllowed(1, 6, 3)).toBe(false);
    });

    it('one per round, never displacing a frontier field, each field once, at most two a session', () => {
        const p = plan({ depth: 4, frontier: frontierOf(2), challengeable: stored });
        expect(p.targets).toHaveLength(2);
        expect(p.challenge).toMatchObject({ fieldKey: 'role' });
        expect(plan({ depth: 4, frontier: frontierOf(2), challengeable: stored, challenged: [stored[0]] }).challenge).toMatchObject({ fieldKey: 'want' });
        expect(plan({ depth: 4, frontier: frontierOf(2), challengeable: stored, challengesPlanned: CHALLENGES_PER_SESSION }).challenge).toBeNull();
        expect(plan({ depth: 3, frontier: [], challengeable: stored }).challenge).toBeNull();
        // A stored field deeper than the dial is not challenged.
        expect(plan({ depth: 4, frontier: [], challengeable: [{ elementId: 'e0', fieldKey: 'arc', level: 5 }] }).challenge).toBeNull();
    });
});

describe('stops', () => {
    const base: StopState = { tokenBudget: 100, tokensUsed: 0, nextRoundTokens: 10, authorStopped: false, roundBudget: 4, roundsRun: 0 };

    it('nothing stops a fresh session', () => {
        expect(decideStop(base)).toBeNull();
    });

    it.each([
        [{ killSwitch: true }, 'KILL_SWITCH'],
        [{ workspaceCeilingReached: true }, 'WORKSPACE_CEILING'],
        [{ tokensUsed: 95 }, 'TOKEN_BUDGET'],
        [{ authorStopped: true }, 'AUTHOR_STOPPED'],
        [{ roundsRun: 4 }, 'ROUND_BUDGET'],
    ] as const)('the minimal state %o stops with %s', (over, reason) => {
        expect(decideStop({ ...base, ...over })).toBe(reason);
    });

    it('checks in the stated order: the frontier, kill switch, ceiling, token budget, author, rounds', () => {
        const all = { ...base, killSwitch: true, workspaceCeilingReached: true, tokensUsed: 95, authorStopped: true, roundsRun: 4 };
        // Nothing left to ask finishes, the kill switch on or not (owner decision 2026-11-19).
        expect(decideStop({ ...all, frontierStop: 'FRONTIER_EMPTY' })).toBe('FRONTIER_EMPTY');
        expect(decideStop({ ...all, frontierStop: 'NOTHING_AT_DEPTH' })).toBe('NOTHING_AT_DEPTH');
        expect(decideStop({ ...all, frontierStop: null })).toBe('KILL_SWITCH');
        expect(decideStop(all)).toBe('KILL_SWITCH');
        expect(decideStop({ ...all, killSwitch: false })).toBe('WORKSPACE_CEILING');
        expect(decideStop({ ...all, killSwitch: false, workspaceCeilingReached: false })).toBe('TOKEN_BUDGET');
        expect(decideStop({ ...all, killSwitch: false, workspaceCeilingReached: false, tokensUsed: 0 })).toBe('AUTHOR_STOPPED');
    });

    it('every stop reason leaves the session in a status other than ACTIVE', () => {
        for (const r of STOP_REASONS) expect(INTERVIEW_STATUSES).toContain(STATUS_AFTER_STOP[r]);
        expect(Object.values(STATUS_AFTER_STOP)).not.toContain('ACTIVE');
    });
});

describe('progress (rule 6: zero is never complete)', () => {
    it('a session that asked nothing is NOT ASSESSED, never 0 % or 100 %', () => {
        expect(sessionProgress([])).toEqual({ status: 'NOT_ASSESSED', asked: 0 });
    });

    it('otherwise it counts what the author did with each question', () => {
        expect(sessionProgress([{ status: 'ANSWERED' }, { status: 'SKIPPED' }, { status: 'DECIDE_LATER' }, { status: null }])).toEqual({
            status: 'MEASURED',
            asked: 4,
            answered: 1,
            skipped: 1,
            deferred: 1,
            unanswered: 1,
            answeredShare: 0.25,
        });
    });
});

describe('dials', () => {
    it('six rounds is the most any depth allows, and the token budget grows with rounds and personas', () => {
        expect(Object.values(DEPTH).map((d) => d.roundBudget)).toEqual([2, 3, 4, 5, 6]);
        expect(roundBudgetFor(3)).toBe(4);
        expect(tokenBudgetFor(3, 0)).toBe(tokenBudgetFor(3, 1));
        expect(tokenBudgetFor(3, 3)).toBeGreaterThan(tokenBudgetFor(3, 1));
    });
});
