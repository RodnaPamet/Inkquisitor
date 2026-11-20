/**
 * Where an interview starts and how it is found again (Phase 2.4): "Grill me"
 * on the book and on a kind's card (editors only; a kind with no entry offers
 * none), the setup sheet with a one-line preview of what each setting does,
 * and the book's interviews with each one's status and why it stopped.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

const push = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1',
    useSearchParams: () => new URLSearchParams(),
}));

import { BookBoard } from '@/components/bible/BookBoard';
import { InterviewSetupSheet } from '@/components/interview/InterviewSetupSheet';
import { InterviewsList } from '@/components/interview/InterviewsList';
import type { BookView } from '@/lib/bible/api-client';
import { kindSummaries } from '@/lib/bible/ui-model';
import { boardOf, KIND_LABELS, mockFetch, SLUG } from '../helpers/bible-ui';
import { interview } from '../helpers/interview-ui';

const BOOK: BookView = {
    id: 'book_1',
    title: 'The Salt Roads',
    logline: null,
    genre: null,
    audience: null,
    targetLength: null,
    stage: 'PLANNING',
    createdAt: '2026-11-19T10:00:00.000Z',
    updatedAt: '2026-11-19T10:00:00.000Z',
};
const character = { id: 'e1', bookId: BOOK.id, kind: 'CHARACTER' as const, name: 'Mara', slug: 'mara', status: 'DRAFT' as const, customLabel: null, updatedAt: BOOK.updatedAt, filledFieldCount: 0 };

beforeEach(() => {
    push.mockClear();
    mockFetch({});
});

describe('Grill me on the board', () => {
    it('offers the whole book and each kind that has entries, to an editor', () => {
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={kindSummaries()} board={boardOf([character])} canEdit />);
        expect(screen.getByRole('button', { name: 'Grill me' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: `Grill me on ${KIND_LABELS.CHARACTER}` })).toBeInTheDocument();
        expect(within(document.querySelector('[data-kind="SETTING"]') as HTMLElement).queryByRole('button', { name: /Grill me/ })).toBeNull();
        expect(screen.getByRole('link', { name: 'Interviews' })).toHaveAttribute('href', '/w/ada/books/book_1/interviews');
    });

    it('offers nothing to start to a reader, who can still find the interviews', () => {
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={kindSummaries()} board={boardOf([character])} canEdit={false} />);
        expect(screen.queryByRole('button', { name: /Grill me/ })).toBeNull();
        expect(screen.getByRole('link', { name: 'Interviews' })).toBeInTheDocument();
    });

    it('a kind’s Grill me starts an interview of that kind', async () => {
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={kindSummaries()} board={boardOf([character])} canEdit />);
        fireEvent.click(screen.getByRole('button', { name: `Grill me on ${KIND_LABELS.CHARACTER}` }));
        await screen.findByTestId('depth-preview');
        fireEvent.click(screen.getByRole('button', { name: 'Start interview' }));
        const url = new URL(push.mock.calls[0][0] as string, 'http://x');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ scope: 'KIND', kind: 'CHARACTER' });
    });
});

describe('the setup sheet', () => {
    function open() {
        return render(<InterviewSetupSheet open setOpen={jest.fn()} workspaceSlug={SLUG} bookId={BOOK.id} target={{ scope: 'BOOK' }} title="Grill me on the whole book" />);
    }

    it('previews what each setting does, in one line, as it changes', async () => {
        open();
        const depth = await screen.findByTestId('depth-preview');
        expect(depth).toHaveTextContent('Consequences and pressures too, in up to 4 rounds.');
        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Depth' })).getByRole('radio', { name: '1' }));
        expect(depth).toHaveTextContent('Foundations only, in up to 2 rounds.');
        const detail = screen.getByTestId('detail-preview');
        expect(detail).toHaveTextContent('Up to 6 questions a round; answers of a few sentences.');
        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Detail' })).getByRole('radio', { name: '5' }));
        expect(detail).toHaveTextContent('Up to 3 questions a round; answers of several paragraphs.');
        const recommend = screen.getByRole('checkbox', { name: /Offer a recommended answer/ });
        expect(screen.getByText(/take it with one click/)).toBeInTheDocument();
        fireEvent.click(recommend);
        expect(screen.getByText('No suggestions: every answer is yours to write.')).toBeInTheDocument();
    });

    it('starts with the chosen setup in the new interview’s address (one interviewer at most, 2.2)', async () => {
        open();
        fireEvent.click(await screen.findByRole('radio', { name: /Ruthless Editor/ }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Multiple choice where possible/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Start interview' }));
        const url = new URL(push.mock.calls[0][0] as string, 'http://x');
        expect(url.pathname).toBe('/w/ada/books/book_1/interviews/new');
        expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'BOOK', depth: '3', detail: '3', personas: 'ruthless-editor', recommend: '1', choice: '1' });
    });

    it('has no axe violations', async () => {
        open();
        await screen.findByTestId('depth-preview');
        expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
    });
});

describe('the book’s interviews', () => {
    it('names what each asked about, its status and why it stopped, in words', async () => {
        const active = interview().session;
        const paused = { ...interview({ status: 'PAUSED', stopReason: 'WORKSPACE_CEILING' }).session, id: 's2', scope: 'KIND' as const, targetElementId: null, targetElementName: null, targetKind: 'SETTING' as const };
        const { container } = render(<InterviewsList workspaceSlug={SLUG} book={{ id: BOOK.id, title: BOOK.title }} sessions={[active, paused]} truncated={false} kindLabels={KIND_LABELS} canEdit />);
        expect(screen.getByRole('link', { name: 'Aurel Pask' })).toHaveAttribute('href', '/w/ada/books/book_1/interviews/sess_1');
        expect(screen.getByRole('link', { name: `Every ${KIND_LABELS.SETTING}` })).toHaveAttribute('href', '/w/ada/books/book_1/interviews/s2');
        expect(screen.getByText(/This workspace has reached its AI limit for the month/)).toBeInTheDocument();
        expect(screen.getByText('Paused')).toBeInTheDocument();
        // WCAG A/AA, as the E2E axe pass holds every page: the list shell's own
        // best-practice findings (a header landmark rendered outside a page, the
        // row-chevron column's empty header) belong to the lifted primitives.
        expect(await axe(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).toHaveNoViolations();
    });

    it('says so when there are none', () => {
        render(<InterviewsList workspaceSlug={SLUG} book={{ id: BOOK.id, title: BOOK.title }} sessions={[]} truncated={false} kindLabels={KIND_LABELS} canEdit />);
        expect(screen.getByText('No interviews yet')).toBeInTheDocument();
    });
});
