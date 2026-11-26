/**
 * The browser's side of the source library API (Phase 4.0): the URL table
 * over the bible's `bibleFetch` (a refusal throws `BibleApiError` with its
 * `details.reason`, which the pages word through next-intl). Types only from
 * the usecases. Client-safe.
 */
import { answerOf, bibleFetch } from '@/lib/bible/api-client';
import type { LibraryListing, SourceView } from '@/app-layer/usecases/source-library';
import type { FactsPage, FactView } from '@/app-layer/usecases/source-facts';
import type { FactProposalsPage, FactProposalView, ProposalFactView } from '@/app-layer/usecases/fact-proposals';
import type { FactProposalDecision } from '@/lib/facts/vocabulary';

export type { FactProposalsPage, FactProposalView, FactsPage, FactView, LibraryListing, ProposalFactView, SourceView };

const enc = encodeURIComponent;

/** Whose library a page shows: a book's, or (`bookId: null`) the workspace's series library. */
export interface LibraryRef {
    slug: string;
    bookId: string | null;
}

const ws = (slug: string) => `/api/w/${enc(slug)}`;

export interface FactsQuery {
    status?: string;
    sourceId?: string;
    after?: string;
}

export const SOURCES_API = {
    library: (ref: LibraryRef) => (ref.bookId ? `${ws(ref.slug)}/books/${enc(ref.bookId)}/sources` : `${ws(ref.slug)}/series/sources`),
    source: (slug: string, sourceId: string) => `${ws(slug)}/sources/${enc(sourceId)}`,
    ingest: (slug: string, sourceId: string) => `${ws(slug)}/sources/${enc(sourceId)}/ingest`,
    optIn: (slug: string, bookId: string, sourceId: string) => `${ws(slug)}/books/${enc(bookId)}/series-sources/${enc(sourceId)}`,
    facts: (ref: LibraryRef, query: FactsQuery) => {
        const q = new URLSearchParams();
        if (query.status) q.set('status', query.status);
        if (query.sourceId) q.set('sourceId', query.sourceId);
        if (query.after) q.set('after', query.after);
        const tail = q.toString();
        return `${ref.bookId ? `${ws(ref.slug)}/books/${enc(ref.bookId)}/facts` : `${ws(ref.slug)}/series/facts`}${tail ? `?${tail}` : ''}`;
    },
    decision: (slug: string, factId: string) => `${ws(slug)}/facts/${enc(factId)}/decision`,
    bulkConfirm: (slug: string) => `${ws(slug)}/facts/bulk-confirm`,
    override: (slug: string, bookId: string, factId: string) => `${ws(slug)}/books/${enc(bookId)}/facts/${enc(factId)}/override`,
    proposals: (slug: string, bookId: string) => `${ws(slug)}/books/${enc(bookId)}/fact-proposals`,
    proposalDecision: (slug: string, bookId: string, proposalId: string) => `${ws(slug)}/books/${enc(bookId)}/fact-proposals/${enc(proposalId)}/decision`,
} as const;

/** The file to the upload route: the body is the file, its name in a header (never the URL). */
async function upload(ref: LibraryRef, file: File): Promise<{ source: SourceView }> {
    const res = await fetch(SOURCES_API.library(ref), {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-source-filename': enc(file.name) },
        body: file,
        credentials: 'same-origin',
        cache: 'no-store',
    });
    return answerOf<{ source: SourceView }>(res);
}

export type FactsViewBody = { kind: 'book'; bookId: string } | { kind: 'series' };

export const sourcesApi = {
    list: (ref: LibraryRef) => bibleFetch<LibraryListing>(SOURCES_API.library(ref)),
    upload,
    get: (slug: string, sourceId: string) => bibleFetch<{ source: SourceView }>(SOURCES_API.source(slug, sourceId)),
    remove: (slug: string, sourceId: string) => bibleFetch<{ removed: true }>(SOURCES_API.source(slug, sourceId), { method: 'DELETE' }),
    ingest: (slug: string, sourceId: string, confirmWorstCaseMicroUsd: number) =>
        bibleFetch<{ sourceId: string }>(SOURCES_API.ingest(slug, sourceId), { method: 'POST', body: { confirmWorstCaseMicroUsd } }),
    optIn: (slug: string, bookId: string, sourceId: string, on: boolean) => bibleFetch<{ optedIn: boolean }>(SOURCES_API.optIn(slug, bookId, sourceId), { method: on ? 'PUT' : 'DELETE' }),
    facts: (ref: LibraryRef, query: FactsQuery = {}) => bibleFetch<FactsPage>(SOURCES_API.facts(ref, query)),
    decide: (slug: string, factId: string, decision: 'CONFIRM' | 'REJECT') =>
        bibleFetch<{ fact: { id: string; status: string } }>(SOURCES_API.decision(slug, factId), { method: 'POST', body: { decision } }),
    bulkConfirm: (slug: string, body: { view: FactsViewBody; offeredIds: string[]; issuedAt: number; token: string; factIds: string[] }) =>
        bibleFetch<{ confirmed: number; skipped: number }>(SOURCES_API.bulkConfirm(slug), { method: 'POST', body }),
    setOverride: (slug: string, bookId: string, factId: string, text: string) => bibleFetch<{ factId: string }>(SOURCES_API.override(slug, bookId, factId), { method: 'PUT', body: { text } }),
    clearOverride: (slug: string, bookId: string, factId: string) => bibleFetch<{ cleared: boolean }>(SOURCES_API.override(slug, bookId, factId), { method: 'DELETE' }),
    proposals: (slug: string, bookId: string) => bibleFetch<FactProposalsPage>(SOURCES_API.proposals(slug, bookId)),
    decideProposal: (slug: string, bookId: string, proposalId: string, decision: FactProposalDecision) =>
        bibleFetch<{ proposal: { id: string; status: string } }>(SOURCES_API.proposalDecision(slug, bookId, proposalId), { method: 'POST', body: { decision } }),
};

/** µUSD as dollars for display ("$0.42"; under a cent "< $0.01"). */
export function formatMicroUsd(micro: number): string {
    if (micro > 0 && micro < 10_000) return '< $0.01';
    return `$${(micro / 1_000_000).toFixed(2)}`;
}
