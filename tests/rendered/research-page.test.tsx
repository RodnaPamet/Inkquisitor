/**
 * The Research page (Phase 2.6): write a brief (question, purpose, scope,
 * URLs, depth); run it; a live run's progress; a finished run that kept
 * nothing says why (rule 6); findings with their quoted, linked sources;
 * proposals reviewed with 2.5's review UI; a reader reads and decides nothing;
 * refusals worded from their reason; no axe violation.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Toaster } from 'sonner';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/research',
    useSearchParams: () => new URLSearchParams(),
}));

import { ResearchPage } from '@/components/research/ResearchPage';
import { applyResearchEvent, INITIAL_RESEARCH_STREAM } from '@/components/research/use-research-stream';
import type { BriefView, RunReviewView, RunView } from '@/lib/research/api-client';
import { getFieldDef } from '@/lib/bible/templates';
import { EMPTY_PROGRESS } from '@/lib/research/vocabulary';
import { KIND_LABELS, mockFetch, SLUG } from '../helpers/bible-ui';

const BOOK = { id: 'book_1', title: 'The Mews' };
const API = `/api/w/${SLUG}/books/${BOOK.id}/research`;
const ELEMENTS = [{ id: 'e1', name: 'Wren', kind: 'CHARACTER' as const }];

function run(over: Partial<RunView> = {}): RunView {
    return {
        id: 'r1',
        briefId: 'b1',
        status: 'DONE',
        outcome: 'OK',
        depth: 'QUICK',
        progress: { ...EMPTY_PROGRESS, phase: 'finished' },
        spentMicroUsd: 42_000,
        createdAt: '2026-11-20T10:00:00.000Z',
        finishedAt: '2026-11-20T10:01:00.000Z',
        metrics: { searches: 2, fetches: 3, sourcesRead: 3, findingsDrafted: 2, findingsKept: 1, proposalsKept: 1, findingRefusals: {}, fitRefusals: {}, reviewRequired: false, errorCode: null },
        ...over,
    };
}

function brief(over: Partial<BriefView> = {}): BriefView {
    return {
        id: 'b1',
        question: 'How did medieval falconers train hawks?',
        purpose: 'Methods for my falconer.',
        depth: 'QUICK',
        status: 'DONE',
        urls: ['https://falconry.example.org/manning'],
        scope: [{ id: 'e1', name: 'Wren', kind: 'CHARACTER' }],
        sources: [{ id: 's1', filename: 'notes.txt', byteLength: 120 }],
        createdAt: '2026-11-20T09:00:00.000Z',
        latestRun: run(),
        ...over,
    };
}

const REVIEW: RunReviewView = {
    run: run(),
    findings: [
        {
            id: 'f-1',
            ref: 'f1',
            claim: 'Falconers began by manning the bird.',
            summary: 'Falconers kept the bird on the fist for hours.',
            confidence: 'HIGH',
            noFitReason: null,
            keptElementId: null,
            citations: [{ id: 'c1', kind: 'URL', url: 'https://falconry.example.org/manning', title: 'Manning a hawk', quotedSpan: 'Medieval falconers began training by manning the bird.', retrievedAt: null }],
        },
    ],
    fields: [
        {
            id: 'p1',
            kind: 'FIELD',
            status: 'PENDING',
            operation: 'ADD',
            elementId: 'e1',
            elementName: 'Wren',
            elementKind: 'CHARACTER',
            fieldKey: 'want',
            field: getFieldDef('CHARACTER', 'want')!,
            proposedValue: 'To man the queen’s falcon.',
            currentValue: null,
            baseVersion: 2,
            currentVersion: 2,
            rationale: 'Manning shapes what she wants.',
            flags: ['POSSIBLE_INSTRUCTION'],
            findingIds: ['f-1'],
        },
    ],
    newElements: [],
};

function renderPage(over: Partial<Parameters<typeof ResearchPage>[0]> = {}) {
    return render(
        <>
            <ResearchPage workspaceSlug={SLUG} book={BOOK} briefs={[brief()]} truncated={false} elements={ELEMENTS} kindLabels={KIND_LABELS} canEdit initialReview={REVIEW} {...over} />
            <Toaster />
        </>,
    );
}

describe('the research page', () => {
    it('shows the brief, its finished run, the findings with quoted and linked sources, and the proposals; no axe violation', async () => {
        mockFetch({});
        const { container } = renderPage();
        const card = screen.getByTestId('research-brief');
        expect(within(card).getByText('How did medieval falconers train hawks?')).toBeInTheDocument();
        expect(within(card).getByText('About: Wren')).toBeInTheDocument();
        expect(within(card).getByTestId('run-outcome')).toHaveTextContent('Each finding below rests on a passage quoted from its source');
        const finding = screen.getByTestId('research-finding');
        expect(within(finding).getByText(/Medieval falconers began training by manning the bird\./)).toBeInTheDocument();
        const link = within(finding).getByRole('link', { name: 'Manning a hawk' });
        expect(link).toHaveAttribute('href', 'https://falconry.example.org/manning');
        expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
        const proposal = screen.getByTestId('research-field-proposal');
        expect(within(proposal).getByTestId('research-diff-p1')).toBeInTheDocument();
        expect(within(proposal).getByTestId('proposal-flag')).toBeInTheDocument();
        expect(within(proposal).getByText('f1 — Falconers began by manning the bird.')).toBeInTheDocument();
        expect(await axe(container)).toHaveNoViolations();
    });

    it('writes a brief from the form: question, purpose, URLs, depth', async () => {
        const { requests } = mockFetch({ [`POST ${API}/briefs`]: { status: 201, json: { brief: { id: 'b2' } } }, [`GET ${API}/briefs`]: { json: { briefs: [brief()], truncated: false } } });
        renderPage({ briefs: [], initialReview: null });
        fireEvent.change(screen.getByLabelText(/^Question/), { target: { value: 'What did a Regency dance card hold?' } });
        fireEvent.change(screen.getByLabelText(/^What it is for/), { target: { value: 'My heroine’s first ball.' } });
        fireEvent.change(screen.getByLabelText(/^URLs to read/), { target: { value: 'https://regency.example.net/cards\nhttps://regency.example.net/balls' } });
        fireEvent.click(screen.getByLabelText(/^Thorough/));
        fireEvent.click(screen.getByRole('button', { name: 'Save brief' }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({
            question: 'What did a Regency dance card hold?',
            purpose: 'My heroine’s first ball.',
            depth: 'THOROUGH',
            scopeElementIds: [],
            urls: ['https://regency.example.net/cards', 'https://regency.example.net/balls'],
        });
        expect(await screen.findByText('Brief saved.')).toBeInTheDocument();
    });

    it('words a refusal from its reason: a brief that repeats the book', async () => {
        mockFetch({ [`POST ${API}/briefs`]: { status: 400, json: { error: { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'BRIEF_QUOTES_BIBLE' } } } } });
        renderPage({ briefs: [], initialReview: null });
        fireEvent.change(screen.getByLabelText(/^Question/), { target: { value: 'q' } });
        fireEvent.change(screen.getByLabelText(/^What it is for/), { target: { value: 'p' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save brief' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Queries never carry bible text');
    });

    it('runs a brief, and a live run shows its progress', async () => {
        const { requests } = mockFetch({ [`POST ${API}/briefs/b1/runs`]: { status: 202, json: { runId: 'r2' } }, [`GET ${API}/briefs`]: { json: { briefs: [brief({ status: 'QUEUED', latestRun: run({ id: 'r2', status: 'QUEUED', outcome: null }) })], truncated: false } } });
        renderPage({ briefs: [brief({ latestRun: null, status: 'READY' })], initialReview: null });
        fireEvent.click(screen.getByRole('button', { name: 'Run research' }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/briefs/b1/runs'))).toBe(true));
        expect(await screen.findByTestId('run-progress')).toHaveTextContent('Waiting for a worker');
    });

    it('zero is never complete: a run that kept nothing says why', () => {
        mockFetch({});
        renderPage({ briefs: [brief({ latestRun: run({ outcome: 'NO_SOURCES', metrics: { ...run().metrics, findingsKept: 0, proposalsKept: 0 } }) })], initialReview: null });
        expect(screen.getByTestId('run-outcome')).toHaveTextContent('Nothing was found to read');
        expect(screen.queryByRole('button', { name: 'Show results' })).toBeNull();
    });

    it('accept sends the version the author reviewed', async () => {
        const { requests } = mockFetch({ [`POST ${API}/proposals/p1/accept`]: { json: { decision: { proposalId: 'p1', status: 'ACCEPTED', elementId: 'e1', versionNumber: 3 } } }, [`GET ${API}/runs/r1`]: { json: { review: REVIEW } } });
        renderPage();
        fireEvent.click(screen.getByRole('button', { name: /^Accept the change to/ }));
        await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true));
        expect(requests.find((r) => r.method === 'POST')!.body).toEqual({ baseVersion: 2 });
    });

    it('a reader reads everything and decides nothing', () => {
        mockFetch({});
        renderPage({ canEdit: false });
        expect(screen.queryByRole('button', { name: 'Save brief' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Keep as research note' })).toBeNull();
        expect(screen.getByTestId('research-finding')).toBeInTheDocument();
    });
});

describe('the progress stream reducer', () => {
    it('applies progress, then the finished run', () => {
        const p = applyResearchEvent(INITIAL_RESEARCH_STREAM, { type: 'progress', progress: { ...EMPTY_PROGRESS, phase: 'reading', fetches: 2 } });
        expect(p.progress).toMatchObject({ phase: 'reading', fetches: 2 });
        const f = applyResearchEvent(p, { type: 'finished', run: run() });
        expect(f.finished?.outcome).toBe('OK');
        expect(applyResearchEvent(f, { type: 'refusal', reason: 'NOT_FOUND' }).refusal).toBe('NOT_FOUND');
    });
});
