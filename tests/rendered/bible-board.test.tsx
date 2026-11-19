/**
 * A book's home and the books list (Phase 1.2): one card per kind with its
 * entries and completeness — "Not started" for a kind with no entries and
 * "Not assessed" for a template with no fields, never a bar over nothing —
 * and create affordances only for an author the server says may edit.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';

const push = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1',
    useSearchParams: () => new URLSearchParams(),
}));

import { BookBoard } from '@/components/bible/BookBoard';
import { BooksList } from '@/components/bible/BooksList';
import type { BookView, ElementListItemView } from '@/lib/bible/api-client';
import { kindSummaries, type KindSummary } from '@/lib/bible/ui-model';
import { boardOf, mockFetch, SLUG } from '../helpers/bible-ui';

const BOOK: BookView = {
    id: 'book_1',
    title: 'The Salt Roads',
    logline: 'A ferrywoman crosses a drowned country.',
    genre: null,
    audience: null,
    targetLength: null,
    stage: 'PLANNING',
    createdAt: '2026-11-19T10:00:00.000Z',
    updatedAt: '2026-11-19T10:00:00.000Z',
};

const entry = (id: string, kind: ElementListItemView['kind'], name: string, filledFieldCount: number): ElementListItemView => ({
    id,
    bookId: BOOK.id,
    kind,
    name,
    slug: id,
    status: 'DRAFT',
    customLabel: null,
    updatedAt: '2026-11-19T10:00:00.000Z',
    filledFieldCount,
});

const KINDS = kindSummaries();
beforeEach(() => push.mockClear());
const card = (kind: string) => document.querySelector(`[data-kind="${kind}"]`) as HTMLElement;

describe('the book board', () => {
    it('shows each kind once, in the fixed order, with its entries', () => {
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={KINDS} board={boardOf([entry('e1', 'CHARACTER', 'Mara', 7), entry('e2', 'CHARACTER', 'Jon', 0)])} canEdit />);
        const cards = Array.from(screen.getByRole('list', { name: 'Bible sections' }).children);
        expect(cards.map((c) => [c.getAttribute('role'), c.getAttribute('data-kind')])).toEqual(KINDS.map((k) => ['listitem', k.kind]));
        const character = card('CHARACTER');
        expect(within(character).getByRole('link', { name: 'Mara' })).toHaveAttribute('href', '/w/ada/books/book_1/elements/e1');
        expect(character).toHaveTextContent('2 entries');
    });

    it('measures a kind with entries: filled fields out of template fields times entries', () => {
        const fields = KINDS.find((k) => k.kind === 'CHARACTER')!.fieldCount;
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={KINDS} board={boardOf([entry('e1', 'CHARACTER', 'Mara', 7), entry('e2', 'CHARACTER', 'Jon', 0)])} canEdit />);
        const bar = within(card('CHARACTER')).getByRole('progressbar', { name: 'Character completeness' });
        expect(bar).toHaveAttribute('value', '7');
        expect(bar).toHaveAttribute('max', String(fields * 2));
        expect(card('CHARACTER')).toHaveTextContent(`${Math.floor((7 / (fields * 2)) * 100)}% · 7 of ${fields * 2} fields filled`);
        // Each entry has its own figure; an entry with nothing filled is a real 0 of its fields.
        expect(card('CHARACTER')).toHaveTextContent(`0/${fields}`);
    });

    it('reads "Not started", with no bar and no percentage, for a kind with no entries', () => {
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={KINDS} board={boardOf([entry('e1', 'CHARACTER', 'Mara', 3)])} canEdit />);
        const setting = card('SETTING');
        expect(setting).toHaveTextContent('Not started');
        expect(within(setting).queryByRole('progressbar')).toBeNull();
        expect(setting.textContent).not.toMatch(/\d+%/);
    });

    it('reads "Not assessed", never 0% or 100%, for a template with no fields', () => {
        const noFields: KindSummary[] = KINDS.map((k) => (k.kind === 'CUSTOM' ? { ...k, fieldCount: 0 } : k));
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={noFields} board={boardOf([entry('c1', 'CUSTOM', 'The prophecy', 0)])} canEdit />);
        const custom = card('CUSTOM');
        expect(custom).toHaveTextContent('Not assessed');
        expect(within(custom).queryByRole('progressbar')).toBeNull();
        expect(custom.textContent).not.toMatch(/\d+%/);
    });

    it('opens the create modal with the kind of the card it was asked from', async () => {
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={KINDS} board={boardOf([])} canEdit />);
        fireEvent.click(within(card('FACTION')).getByRole('button', { name: 'Add Faction' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Faction')).toBeInTheDocument();
    });

    it('creates an element from the modal and opens its page', async () => {
        const { requests } = mockFetch({ 'POST /api/w/ada/books/book_1/elements': { status: 201, json: { element: { id: 'new_1' } } } });
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={KINDS} board={boardOf([])} canEdit />);
        fireEvent.click(within(card('CUSTOM')).getByRole('button', { name: 'Add Custom element' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'The prophecy' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Create entry' }));
        // A custom entry needs its own label: nothing is sent without one.
        expect(await within(dialog).findByText('A custom entry needs its own label.')).toBeInTheDocument();
        expect(requests).toHaveLength(0);
        fireEvent.change(within(dialog).getByLabelText(/^Custom kind/), { target: { value: 'Prophecy' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Create entry' }));
        await waitFor(() => expect(push).toHaveBeenCalled());
        expect(requests).toEqual([{ method: 'POST', url: '/api/w/ada/books/book_1/elements', body: { kind: 'CUSTOM', name: 'The prophecy', customLabel: 'Prophecy' } }]);
        expect(push).toHaveBeenCalledWith('/w/ada/books/book_1/elements/new_1');
    });

    it('has no axe violations', async () => {
        const { container } = render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={KINDS} board={boardOf([entry('e1', 'CHARACTER', 'Mara', 3)])} canEdit />);
        expect(await axe(container)).toHaveNoViolations();
    });

    it('offers a reader no create affordance at all', () => {
        render(<BookBoard workspaceSlug={SLUG} book={BOOK} kinds={KINDS} board={boardOf([entry('e1', 'CHARACTER', 'Mara', 3)])} canEdit={false} />);
        expect(screen.queryByRole('button', { name: 'Element' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
        // Reading still works.
        expect(screen.getByRole('link', { name: 'Mara' })).toBeInTheDocument();
    });
});

describe('the books list', () => {
    it('lists the books, each linking to its home', () => {
        render(<BooksList workspaceSlug={SLUG} books={[BOOK]} canEdit />);
        expect(screen.getByRole('heading', { level: 1, name: 'Books' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'The Salt Roads' })).toHaveAttribute('href', '/w/ada/books/book_1');
        expect(screen.getByText('Planning')).toBeInTheDocument();
    });

    it('creates a book from the modal and opens it', async () => {
        const { requests } = mockFetch({ 'POST /api/w/ada/books': { status: 201, json: { book: { ...BOOK, id: 'book_9' } } } });
        render(<BooksList workspaceSlug={SLUG} books={[]} canEdit />);
        expect(screen.getByText('No books yet.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Book' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText(/^Working title/), { target: { value: 'Salt Roads' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Create book' }));
        await waitFor(() => expect(push).toHaveBeenCalledWith('/w/ada/books/book_9'));
        expect(requests).toEqual([{ method: 'POST', url: '/api/w/ada/books', body: { title: 'Salt Roads' } }]);
    });

    it('offers a reader no create button', () => {
        render(<BooksList workspaceSlug={SLUG} books={[BOOK]} canEdit={false} />);
        expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    });
});
