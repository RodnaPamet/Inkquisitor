/**
 * ZERO IS NEVER COMPLETE (Phase 4.H-a, roadmap 4.H item 7; rule 6), on the two
 * pages a fact set is read on: an empty fact set reads "not assessed", never a
 * clean bill; and the Continuity page never says "every fact checked" of a pass
 * that read a cut set of facts or passed subjects over (#62 items 1 and 3).
 */
import { render, screen } from '@testing-library/react';
import { Toaster } from 'sonner';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/continuity',
    useSearchParams: () => new URLSearchParams(),
}));

import { ContinuityPage } from '@/components/continuity/ContinuityPage';
import { FactsReview } from '@/components/sources/FactsReview';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import type { ContinuityPage as PageData } from '@/lib/continuity/api-client';
import type { FactsPage } from '@/lib/sources/api-client';
import { mockFetch } from '../helpers/bible-ui';

const BOOK = { id: 'book_1', title: 'The Salt Roads' };

function continuity(over: Partial<PageData> = {}, nightly: Partial<PageData['nightly']> = {}): PageData {
    return {
        assessed: true,
        liveFacts: 12,
        contradictions: { items: [], pending: 0, truncated: false },
        noLongerStated: { items: [], pending: 0, truncated: false },
        threads: { items: [], truncated: false },
        threadProposals: { items: [], pending: 0, truncated: false },
        decideLater: { items: [], truncated: false },
        stale: { items: [], truncated: false },
        nightly: {
            lastRunAt: '2026-11-26T02:30:00.000Z',
            outcome: 'OK',
            subjectsCovered: 3,
            subjectsRemaining: 0,
            factsRead: 12,
            coveredThrough: '2026-11-26T02:15:00.000Z',
            passUnderWay: false,
            factsCut: false,
            parkedSubjects: 0,
            complete: true,
            ...nightly,
        },
        ...over,
    };
}

function mountContinuity(page: PageData) {
    return render(
        <KeyboardShortcutProvider>
            <ContinuityPage workspaceSlug="ada" book={BOOK} initial={page} canEdit />
            <Toaster />
        </KeyboardShortcutProvider>,
    );
}

beforeEach(() => mockFetch({}));

describe('the Continuity page', () => {
    it('a book whose fact set is empty reads "not assessed", never a clean bill', () => {
        mountContinuity(continuity({ assessed: false, liveFacts: 0 }, { lastRunAt: null, outcome: null, coveredThrough: null, complete: false, factsRead: 0, subjectsCovered: 0 }));
        expect(screen.getByTestId('continuity-status')).toHaveTextContent('Not assessed yet');
        expect(screen.queryByText(/every fact checked/)).toBeNull();
    });

    it('a complete pass, nothing cut or passed over, says every fact was checked', () => {
        mountContinuity(continuity());
        expect(screen.getByTestId('continuity-nightly')).toHaveTextContent('every fact checked');
        expect(screen.queryByTestId('continuity-nightly-cut')).toBeNull();
    });

    it('a pass over a cut set of facts names the cut and never says every fact was checked (#62 item 1)', () => {
        mountContinuity(continuity({ liveFacts: 4_100 }, { factsRead: 4_000, factsCut: true, complete: false }));
        expect(screen.getByTestId('continuity-nightly')).toHaveTextContent('the pass finished, but not every fact was checked');
        expect(screen.getByTestId('continuity-nightly')).not.toHaveTextContent('every fact checked');
        expect(screen.getByTestId('continuity-nightly-cut')).toHaveTextContent('4000');
        expect(screen.getByTestId('continuity-nightly-cut')).toHaveTextContent('4100');
    });

    it('a pass that passed subjects over says so (#62 item 3)', () => {
        mountContinuity(continuity({}, { parkedSubjects: 2, complete: false }));
        expect(screen.getByTestId('continuity-nightly')).toHaveTextContent('not every fact was checked');
        expect(screen.getByTestId('continuity-nightly-parked')).toBeInTheDocument();
    });
});

describe('the Facts page', () => {
    it('an empty fact set reads "not assessed"', () => {
        const page: FactsPage = { facts: [], counts: { PENDING: 0, CONFIRMED: 0, REJECTED: 0 }, offered: { ids: [], issuedAt: 0, token: '' }, nextCursor: null, sources: [] };
        render(
            <KeyboardShortcutProvider>
                <FactsReview workspaceSlug="ada" book={BOOK} initial={page} canEdit />
                <Toaster />
            </KeyboardShortcutProvider>,
        );
        expect(screen.getByText('Not assessed')).toBeInTheDocument();
    });
});
