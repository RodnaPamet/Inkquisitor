/**
 * The browser's side of the research API (Phase 2.6): the URL table for the
 * routes under `/api/w/<slug>/books/<bookId>/research/`, over the bible's
 * `bibleFetch` (a refusal throws `BibleApiError` with its `details.reason`,
 * which the page words through next-intl). Types only from the usecases.
 * Client-safe.
 */
import { bibleFetch, bibleUpload } from '@/lib/bible/api-client';
import type { FieldValue } from '@/lib/bible/field-values';
import type { BriefView, FindingView, ResearchFieldProposalView, ResearchNewElementView, ResearchSceneNoteView, RunReviewView, RunView } from '@/app-layer/usecases/research-pages';
import type { ResearchDecisionResult } from '@/app-layer/usecases/research-review';
import type { ResearchDepth } from './vocabulary';

export type { BriefView, FindingView, ResearchDecisionResult, ResearchFieldProposalView, ResearchNewElementView, ResearchSceneNoteView, RunReviewView, RunView };

const enc = encodeURIComponent;

export interface ResearchIds {
    slug: string;
    bookId: string;
}

const base = (ids: ResearchIds) => `/api/w/${enc(ids.slug)}/books/${enc(ids.bookId)}/research`;

export const RESEARCH_API = {
    briefs: (ids: ResearchIds) => `${base(ids)}/briefs`,
    sources: (ids: ResearchIds, briefId: string, filename: string) => `${base(ids)}/briefs/${enc(briefId)}/sources?filename=${enc(filename)}`,
    runs: (ids: ResearchIds, briefId: string) => `${base(ids)}/briefs/${enc(briefId)}/runs`,
    run: (ids: ResearchIds, runId: string) => `${base(ids)}/runs/${enc(runId)}`,
    stream: (ids: ResearchIds, runId: string) => `${base(ids)}/runs/${enc(runId)}/stream`,
    keep: (ids: ResearchIds, runId: string, findingId: string) => `${base(ids)}/runs/${enc(runId)}/findings/${enc(findingId)}/keep`,
    accept: (ids: ResearchIds, proposalId: string) => `${base(ids)}/proposals/${enc(proposalId)}/accept`,
    reject: (ids: ResearchIds, proposalId: string) => `${base(ids)}/proposals/${enc(proposalId)}/reject`,
} as const;

export interface CreateBriefBody {
    question: string;
    purpose: string;
    scopeElementIds: string[];
    /** Phase 5.1: the manuscript chapters it is for. */
    scopeChapterIds?: string[];
    urls: string[];
    depth: ResearchDepth;
}

export interface ResearchAcceptBody {
    baseVersion?: number;
    reviewedCurrent?: boolean;
    value?: FieldValue | null;
    name?: string;
    summary?: string | null;
}

/** A file's bytes to the attach route (the body is the file, as the bundle import's). */
function attach(ids: ResearchIds, briefId: string, file: File): Promise<{ source: { id: string; filename: string; byteLength: number } }> {
    const type = file.name.toLowerCase().endsWith('.md') ? 'text/markdown' : file.type || 'text/plain';
    return bibleUpload(RESEARCH_API.sources(ids, briefId, file.name), file, type);
}

export const researchApi = {
    briefs: (ids: ResearchIds) => bibleFetch<{ briefs: BriefView[]; truncated: boolean }>(RESEARCH_API.briefs(ids)),
    createBrief: (ids: ResearchIds, body: CreateBriefBody) => bibleFetch<{ brief: { id: string } }>(RESEARCH_API.briefs(ids), { method: 'POST', body }),
    attach,
    dispatch: (ids: ResearchIds, briefId: string) => bibleFetch<{ runId: string }>(RESEARCH_API.runs(ids, briefId), { method: 'POST' }),
    review: (ids: ResearchIds, runId: string) => bibleFetch<{ review: RunReviewView }>(RESEARCH_API.run(ids, runId)),
    keep: (ids: ResearchIds, runId: string, findingId: string) => bibleFetch<{ kept: { elementId: string } }>(RESEARCH_API.keep(ids, runId, findingId), { method: 'POST' }),
    accept: (ids: ResearchIds, proposalId: string, body: ResearchAcceptBody) => bibleFetch<{ decision: ResearchDecisionResult }>(RESEARCH_API.accept(ids, proposalId), { method: 'POST', body }),
    reject: (ids: ResearchIds, proposalId: string) => bibleFetch<{ decision: ResearchDecisionResult }>(RESEARCH_API.reject(ids, proposalId), { method: 'POST' }),
};
