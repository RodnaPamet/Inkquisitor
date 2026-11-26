/**
 * The bounds a session's state is read under (Phase 2.2), held to each other.
 * Every question and every answer row of a session is read in one bounded
 * read; a session that could hold more than the read would be judged on a
 * cut list (an answered question read as unanswered, a field asked again).
 */
import { ANSWER_REVISIONS_MAX } from '@/app-layer/usecases/interview-answers';
import { SESSION_ANSWERS_MAX, SESSION_QUESTIONS_MAX } from '@/app-layer/usecases/interview-state';
import { DETAIL } from '@/lib/interview/dials';
import { REPHRASES_PER_ROUND_MAX } from '@/lib/interview/rephrase';
import { ROUND_QUESTIONS_WORST } from '@/app-layer/usecases/interview-rounds';
import { SESSION_QUESTIONS_CHOSEN_MAX, SESSION_ROUNDS_MAX } from '@/lib/interview/session-length';

it('one round holds at most its cap, its one challenge and its rephrases, and the SESSION_LIMIT stop leaves room for it (Phase 4.4)', () => {
    const largestRound = Math.max(...Object.values(DETAIL).map((d) => d.roundCap)) + 1 + REPHRASES_PER_ROUND_MAX;
    expect(ROUND_QUESTIONS_WORST).toBe(largestRound);
    // A round is claimed only while the session's questions plus one worst round fit the read (`stopNow`).
    expect(ROUND_QUESTIONS_WORST).toBeLessThan(SESSION_QUESTIONS_MAX);
    // The longest session the author may choose fits before SESSION_LIMIT for ordinary rounds.
    expect(SESSION_QUESTIONS_CHOSEN_MAX + ROUND_QUESTIONS_WORST).toBeLessThanOrEqual(SESSION_QUESTIONS_MAX);
    expect(SESSION_ROUNDS_MAX * (Math.max(...Object.values(DETAIL).map((d) => d.roundCap)) + 1)).toBeLessThanOrEqual(SESSION_QUESTIONS_MAX);
});

it('every revision of every answer of a session fits the answer read', () => {
    expect(SESSION_QUESTIONS_MAX * ANSWER_REVISIONS_MAX).toBeLessThanOrEqual(SESSION_ANSWERS_MAX);
});
