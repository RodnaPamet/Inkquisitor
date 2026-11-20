/**
 * The browser's side of the interview API (Phase 2.4): the URL table for the
 * routes under `/api/w/<slug>/books/<bookId>/interviews/**` and the calls the
 * interview page makes, over the bible's `bibleFetch` (one fetch wrapper, one
 * error type: a refusal throws `BibleApiError` with its `details.reason`, which
 * the page words through next-intl). Types only from the usecases.
 *
 * Starting an interview and generating a round are STREAMED
 * (`use-interview-stream.ts`); everything else is one JSON request. The setup
 * sheet's request shape is not here: it is `./setup.ts`, the one place 2.3's
 * dials reach the client.
 *
 * Client-safe: no imports but types and the bible client.
 */
import { bibleFetch } from '@/lib/bible/api-client';
import type { InterviewView, QuestionView, SessionSummaryView } from '@/app-layer/usecases/interview-state';
import type { ReconcileRunView } from '@/app-layer/usecases/enrichment-reconcile';

export type { InterviewView, QuestionView, SessionSummaryView };

const enc = encodeURIComponent;

export const INTERVIEW_API = {
    interviews: (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/interviews`,
    startStream: (slug: string, bookId: string) => `${INTERVIEW_API.interviews(slug, bookId)}/stream`,
    interview: (slug: string, bookId: string, sessionId: string) => `${INTERVIEW_API.interviews(slug, bookId)}/${enc(sessionId)}`,
    nextRoundStream: (slug: string, bookId: string, sessionId: string) => `${INTERVIEW_API.interview(slug, bookId, sessionId)}/rounds/stream`,
    closeRound: (slug: string, bookId: string, sessionId: string, roundNumber: number) => `${INTERVIEW_API.interview(slug, bookId, sessionId)}/rounds/${roundNumber}/close`,
    stop: (slug: string, bookId: string, sessionId: string) => `${INTERVIEW_API.interview(slug, bookId, sessionId)}/stop`,
    question: (slug: string, bookId: string, sessionId: string, questionId: string) => `${INTERVIEW_API.interview(slug, bookId, sessionId)}/questions/${enc(questionId)}`,
} as const;

/** What one answer sends: the reply the question's kind takes, or the recommendation taken as offered. */
export type AnswerBody = { text?: string; choice?: string; scale?: number } | { acceptRecommendation: true };

export interface InterviewIds {
    slug: string;
    bookId: string;
    sessionId: string;
}

export const interviewApi = {
    answer: (ids: InterviewIds, questionId: string, body: AnswerBody) =>
        bibleFetch<{ question: QuestionView }>(`${INTERVIEW_API.question(ids.slug, ids.bookId, ids.sessionId, questionId)}/answer`, { method: 'POST', body }),
    skip: (ids: InterviewIds, questionId: string) => bibleFetch<{ question: QuestionView }>(`${INTERVIEW_API.question(ids.slug, ids.bookId, ids.sessionId, questionId)}/skip`, { method: 'POST' }),
    decideLater: (ids: InterviewIds, questionId: string) =>
        bibleFetch<{ question: QuestionView }>(`${INTERVIEW_API.question(ids.slug, ids.bookId, ids.sessionId, questionId)}/decide-later`, { method: 'POST' }),
    rephrase: (ids: InterviewIds, questionId: string) =>
        bibleFetch<{ question: QuestionView }>(`${INTERVIEW_API.question(ids.slug, ids.bookId, ids.sessionId, questionId)}/rephrase`, { method: 'POST' }),
    closeRound: (ids: InterviewIds, roundNumber: number, skipUnanswered: boolean) =>
        bibleFetch<{ interview: InterviewView; reconcile?: ReconcileRunView | null }>(INTERVIEW_API.closeRound(ids.slug, ids.bookId, ids.sessionId, roundNumber), {
            method: 'POST',
            body: skipUnanswered ? { skipUnanswered: true } : {},
        }),
    stop: (ids: InterviewIds) => bibleFetch<{ interview: InterviewView }>(INTERVIEW_API.stop(ids.slug, ids.bookId, ids.sessionId), { method: 'POST' }),
    get: (ids: InterviewIds) => bibleFetch<{ interview: InterviewView }>(INTERVIEW_API.interview(ids.slug, ids.bookId, ids.sessionId)),
};
