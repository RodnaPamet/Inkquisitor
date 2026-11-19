/**
 * The bounds a session's state is read under (Phase 2.2), held to each other.
 * Every question and every answer row of a session is read in one bounded
 * read; a session that could hold more than the read would be judged on a
 * cut list (an answered question read as unanswered, a field asked again).
 */
import { ANSWER_REVISIONS_MAX } from '@/app-layer/usecases/interview-answers';
import { SESSION_ANSWERS_MAX, SESSION_QUESTIONS_MAX } from '@/app-layer/usecases/interview-state';
import { DETAIL, MAX_ROUNDS } from '@/lib/interview/dials';

it('a session asks no more questions than its state reads: every round at its cap, plus its one challenge', () => {
    const largestRound = Math.max(...Object.values(DETAIL).map((d) => d.roundCap)) + 1;
    expect(MAX_ROUNDS * largestRound).toBeLessThanOrEqual(SESSION_QUESTIONS_MAX);
});

it('every revision of every answer of a session fits the answer read', () => {
    expect(SESSION_QUESTIONS_MAX * ANSWER_REVISIONS_MAX).toBeLessThanOrEqual(SESSION_ANSWERS_MAX);
});
