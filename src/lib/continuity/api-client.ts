/**
 * The browser's side of the Continuity API (Phase 4.2, D28): the URL table over
 * the bible's `bibleFetch` (a refusal throws `BibleApiError` with its
 * `details.reason`, which the page words through next-intl). Types only from
 * the usecases. Client-safe.
 */
import { bibleFetch } from '@/lib/bible/api-client';
import type { ContinuityPage, DecideLaterView, StaleFlagView, ThreadProposalView, ThreadView } from '@/app-layer/usecases/continuity';
import type { FactProposalDecision } from '@/lib/facts/vocabulary';
import type { ThreadKind } from './vocabulary';

export type { ContinuityPage, DecideLaterView, StaleFlagView, ThreadProposalView, ThreadView };

const enc = encodeURIComponent;
const book = (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}`;

export const CONTINUITY_API = {
    page: (slug: string, bookId: string) => `${book(slug, bookId)}/continuity`,
    threads: (slug: string, bookId: string) => `${book(slug, bookId)}/threads`,
    thread: (slug: string, bookId: string, threadId: string) => `${book(slug, bookId)}/threads/${enc(threadId)}`,
    threadProposal: (slug: string, bookId: string, proposalId: string) => `${book(slug, bookId)}/thread-proposals/${enc(proposalId)}/decision`,
    contradiction: (slug: string, bookId: string, proposalId: string) => `${book(slug, bookId)}/fact-proposals/${enc(proposalId)}/decision`,
    dismissStale: (slug: string, bookId: string, flagId: string) => `${book(slug, bookId)}/stale-flags/${enc(flagId)}/dismiss`,
} as const;

export interface ThreadDraft {
    kind: ThreadKind;
    title: string;
    note: string | null;
}

export const continuityApi = {
    page: (slug: string, bookId: string) => bibleFetch<ContinuityPage>(CONTINUITY_API.page(slug, bookId)),
    decideContradiction: (slug: string, bookId: string, proposalId: string, decision: FactProposalDecision, explanation?: string) =>
        bibleFetch<{ proposal: { id: string; status: string } }>(CONTINUITY_API.contradiction(slug, bookId, proposalId), { method: 'POST', body: explanation === undefined ? { decision } : { decision, explanation } }),
    createThread: (slug: string, bookId: string, draft: ThreadDraft) => bibleFetch<{ thread: ThreadView }>(CONTINUITY_API.threads(slug, bookId), { method: 'POST', body: draft }),
    updateThread: (slug: string, bookId: string, threadId: string, body: { baseVersion: number; title?: string; note?: string | null; state?: string }) =>
        bibleFetch<{ thread: ThreadView }>(CONTINUITY_API.thread(slug, bookId, threadId), { method: 'PATCH', body }),
    deleteThread: (slug: string, bookId: string, threadId: string, baseVersion: number) => bibleFetch<{ id: string }>(`${CONTINUITY_API.thread(slug, bookId, threadId)}?baseVersion=${baseVersion}`, { method: 'DELETE' }),
    decideThreadProposal: (slug: string, bookId: string, proposalId: string, decision: 'ACCEPT' | 'REJECT') =>
        bibleFetch<{ proposal: { id: string; status: string } }>(CONTINUITY_API.threadProposal(slug, bookId, proposalId), { method: 'POST', body: { decision } }),
    dismissStale: (slug: string, bookId: string, flagId: string) => bibleFetch<{ flag: { id: string } }>(CONTINUITY_API.dismissStale(slug, bookId, flagId), { method: 'POST' }),
};
