/**
 * The browser's side of the enrichment API (Phase 2.5): the URL table for the
 * routes under `/api/w/<slug>/books/<bookId>/interviews/<sessionId>/` that a
 * review calls, over the bible's `bibleFetch` (a refusal throws
 * `BibleApiError` with its `details.reason`, which the page words through
 * next-intl). Types only from the usecases. Client-safe.
 */
import { bibleFetch } from '@/lib/bible/api-client';
import type { FieldValue } from '@/lib/bible/field-values';
import type {
    CitedAnswerView,
    DecisionResult,
    FieldProposalView,
    NewElementProposalView,
    NewRelationEndView,
    NewRelationProposalView,
    PendingStructureView,
    RelationFieldProposalView,
    SessionReviewView,
} from '@/app-layer/usecases/enrichment-review';
import type { ReconcileRunView } from '@/app-layer/usecases/enrichment-reconcile';

export type {
    CitedAnswerView,
    DecisionResult,
    FieldProposalView,
    NewElementProposalView,
    NewRelationEndView,
    NewRelationProposalView,
    PendingStructureView,
    ReconcileRunView,
    RelationFieldProposalView,
    SessionReviewView,
};

/** Phase 3.3: the book's pending new elements and relations (a story map's ghosts and their list). */
export interface PendingStructureResult {
    proposals: PendingStructureView[];
    answers: Record<string, CitedAnswerView>;
    truncated: boolean;
}

const enc = encodeURIComponent;

export interface ReviewIds {
    slug: string;
    bookId: string;
    sessionId: string;
}

const base = (ids: ReviewIds) => `/api/w/${enc(ids.slug)}/books/${enc(ids.bookId)}/interviews/${enc(ids.sessionId)}`;

export const ENRICHMENT_API = {
    review: (ids: ReviewIds) => `${base(ids)}/proposals`,
    accept: (ids: ReviewIds, proposalId: string) => `${base(ids)}/proposals/${enc(proposalId)}/accept`,
    reject: (ids: ReviewIds, proposalId: string) => `${base(ids)}/proposals/${enc(proposalId)}/reject`,
    bulkAccept: (ids: ReviewIds) => `${base(ids)}/proposals/bulk-accept`,
    reconcile: (ids: ReviewIds, roundNumber: number) => `${base(ids)}/rounds/${roundNumber}/reconcile`,
    pendingStructure: (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}/proposals/pending-structure`,
} as const;

export interface AcceptBody {
    baseVersion?: number;
    reviewedCurrent?: boolean;
    value?: FieldValue | null;
    name?: string;
    summary?: string | null;
}

export const enrichmentApi = {
    review: (ids: ReviewIds) => bibleFetch<{ review: SessionReviewView }>(ENRICHMENT_API.review(ids)),
    accept: (ids: ReviewIds, proposalId: string, body: AcceptBody) => bibleFetch<{ decision: DecisionResult }>(ENRICHMENT_API.accept(ids, proposalId), { method: 'POST', body }),
    reject: (ids: ReviewIds, proposalId: string) => bibleFetch<{ decision: DecisionResult }>(ENRICHMENT_API.reject(ids, proposalId), { method: 'POST' }),
    bulkAccept: (ids: ReviewIds, items: Array<{ proposalId: string; baseVersion: number }>) =>
        bibleFetch<{ decisions: DecisionResult[] }>(ENRICHMENT_API.bulkAccept(ids), { method: 'POST', body: { items } }),
    reconcile: (ids: ReviewIds, roundNumber: number) => bibleFetch<{ reconcile: ReconcileRunView }>(ENRICHMENT_API.reconcile(ids, roundNumber), { method: 'POST' }),
    pendingStructure: (slug: string, bookId: string) => bibleFetch<PendingStructureResult>(ENRICHMENT_API.pendingStructure(slug, bookId)),
};
