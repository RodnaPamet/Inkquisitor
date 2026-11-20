/**
 * The bible UI's Phase 1.H behaviour:
 *
 *   - a save someone else's save has overtaken (409 VERSION_CONFLICT) is held,
 *     never re-sent on its own; the author reloads their version or keeps
 *     their edits and saves them over it;
 *   - the board's counts are the server's aggregates and "Show more" pages a
 *     kind;
 *   - deleting a book offers the export first and needs the title typed;
 *     the recently-deleted list restores; the books list says when it is cut.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { Toaster } from 'sonner';

const push = jest.fn();
const refresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push, refresh, replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1',
    useSearchParams: () => new URLSearchParams(),
}));

import { BookBoard } from '@/components/bible/BookBoard';
import { BooksList } from '@/components/bible/BooksList';
import { DeletedBooksList } from '@/components/bible/DeletedBooksList';
import { ElementPage } from '@/components/bible/ElementPage';
import { AUTOSAVE_DEBOUNCE_MS, clearHeldEditsForTests } from '@/components/bible/use-element-autosave';
import type { BookView, ElementListItemView } from '@/lib/bible/api-client';
import { kindSummaries } from '@/lib/bible/ui-model';
import { API, boardOf, elementView, mockFetch, pageProps, SLUG } from '../helpers/bible-ui';

beforeAll(() => {
    Document.prototype.elementFromPoint = () => null;
});
beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
});

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
const KINDS = kindSummaries();
const entry = (id: string, name: string, filledFieldCount = 0): ElementListItemView => ({
    id,
    bookId: BOOK.id,
    kind: 'CHARACTER',
    name,
    slug: id,
    orderRank: null,
    status: 'DRAFT',
    customLabel: null,
    updatedAt: '2026-11-19T10:00:00.000Z',
    filledFieldCount,
});

describe('a save overtaken by someone else’s', () => {
    const FIELDS = `${API}/elements/el_1/fields`;
    const EL = `${API}/elements/el_1`;
    const conflict = { status: 409, json: { error: { code: 'CONFLICT', message: 'x', details: { reason: 'VERSION_CONFLICT', currentVersion: 5, baseVersion: 3 } } } };
    const saved = (versionNumber: number, values: Record<string, string>) => ({ json: { element: { ...elementView({ versionNumber, values }), changedKeys: Object.keys(values) } } });

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    // A page left in conflict keeps its edits for the tab (module scope); each test starts with none.
    // (Before, not after: the render's own cleanup, which unmounts and so keeps, runs after every afterEach.)
    beforeEach(() => clearHeldEditsForTests());
    const elapse = (ms: number) =>
        act(async () => {
            jest.advanceTimersByTime(ms);
        });
    const role = () => screen.getByTestId('field-input-role') as HTMLInputElement;

    function mount() {
        return render(
            <>
                <ElementPage {...pageProps()} />
                <Toaster />
            </>,
        );
    }

    it('is held and named, and a later edit is not sent over the newer version', async () => {
        const { requests } = mockFetch({ [`PUT ${FIELDS}`]: conflict });
        mount();
        fireEvent.change(role(), { target: { value: 'Ferrywoman' } });
        await elapse(AUTOSAVE_DEBOUNCE_MS);
        expect(requests).toHaveLength(1);
        expect(requests[0].body).toEqual({ fields: [{ key: 'role', value: 'Ferrywoman' }], baseVersion: 3 });
        const notice = screen.getByTestId('version-conflict');
        expect(notice).toHaveAttribute('role', 'alert');
        expect(notice).toHaveTextContent('It is now at version 5');
        expect(screen.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict');
        // Typing on does not send: never silently over the other writer's save.
        fireEvent.change(screen.getByTestId('field-input-want'), { target: { value: 'To cross' } });
        await elapse(AUTOSAVE_DEBOUNCE_MS * 3);
        expect(requests).toHaveLength(1);
        expect(role().value).toBe('Ferrywoman');
    });

    it('"Keep my edits" saves every held edit over the version the server named', async () => {
        let first = true;
        const { requests } = mockFetch({
            [`PUT ${FIELDS}`]: () => {
                if (first) {
                    first = false;
                    return conflict;
                }
                return saved(6, { role: 'Ferrywoman', want: 'To cross' });
            },
        });
        mount();
        fireEvent.change(role(), { target: { value: 'Ferrywoman' } });
        await elapse(AUTOSAVE_DEBOUNCE_MS);
        fireEvent.change(screen.getByTestId('field-input-want'), { target: { value: 'To cross' } });
        fireEvent.click(screen.getByRole('button', { name: 'Keep my edits' }));
        await elapse(0);
        expect(requests).toHaveLength(2);
        expect(requests[1].body).toEqual({
            fields: [
                { key: 'role', value: 'Ferrywoman' },
                { key: 'want', value: 'To cross' },
            ],
            baseVersion: 5,
        });
        expect(screen.queryByTestId('version-conflict')).toBeNull();
        expect(screen.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    });

    it('"Reload their version" drops the held edits, shows the element as saved, and bases the next save on it', async () => {
        const theirs = elementView({ versionNumber: 5, values: { role: 'Pilot' } });
        const { requests } = mockFetch({
            [`PUT ${FIELDS}`]: () => (requests.filter((r) => r.method === 'PUT').length === 1 ? conflict : saved(6, { role: 'Pilot captain' })),
            [`GET ${EL}`]: { json: { element: theirs } },
        });
        mount();
        fireEvent.change(role(), { target: { value: 'Ferrywoman' } });
        await elapse(AUTOSAVE_DEBOUNCE_MS);
        fireEvent.click(screen.getByRole('button', { name: 'Reload their version' }));
        await elapse(0);
        expect(screen.queryByTestId('version-conflict')).toBeNull();
        expect(role().value).toBe('Pilot');
        // Nothing of the dropped edit is sent; the next edit is based on their version.
        fireEvent.change(role(), { target: { value: 'Pilot captain' } });
        await elapse(AUTOSAVE_DEBOUNCE_MS);
        const puts = requests.filter((r) => r.method === 'PUT');
        expect(puts).toHaveLength(2);
        expect(puts[1].body).toEqual({ fields: [{ key: 'role', value: 'Pilot captain' }], baseVersion: 5 });
    });

    describe('leaving the page while edits are held', () => {
        const LEAVE = 'Someone else saved this entry after your edits began, and your edits are not saved. Leave this page and discard them?';
        afterEach(() => {
            document.querySelectorAll('a[data-test-leave]').forEach((a) => a.remove());
        });
        /** An in-app link outside the page (the sidebar's, a breadcrumb's). */
        function inAppLink(href = '/w/ada/books') {
            const a = document.createElement('a');
            a.href = href;
            a.textContent = 'Books';
            a.setAttribute('data-test-leave', '');
            document.body.appendChild(a);
            return a;
        }
        async function inConflict() {
            const fetched = mockFetch({ [`PUT ${FIELDS}`]: conflict });
            const view = mount();
            fireEvent.change(role(), { target: { value: 'Ferrywoman' } });
            await elapse(AUTOSAVE_DEBOUNCE_MS);
            expect(screen.getByTestId('version-conflict')).toBeInTheDocument();
            return { ...fetched, ...view };
        }

        it('a link asks first; staying keeps the page and its edits', async () => {
            const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
            const { requests } = await inConflict();
            const followed = fireEvent.click(inAppLink());
            expect(confirm).toHaveBeenCalledWith(LEAVE);
            expect(followed).toBe(false); // the navigation was cancelled
            expect(role().value).toBe('Ferrywoman');
            expect(requests).toHaveLength(1);
            confirm.mockRestore();
        });

        it('leaving on purpose drops the edits: nothing is sent and nothing comes back', async () => {
            const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
            const { requests, unmount } = await inConflict();
            expect(fireEvent.click(inAppLink())).toBe(true);
            unmount();
            await elapse(AUTOSAVE_DEBOUNCE_MS);
            expect(requests).toHaveLength(1);
            mount();
            expect(screen.queryByTestId('version-conflict')).toBeNull();
            expect(role().value).toBe('');
            confirm.mockRestore();
        });

        it('a link with no conflict held, or opening a new tab, is never asked about', async () => {
            const confirm = jest.spyOn(window, 'confirm');
            mockFetch({});
            mount();
            fireEvent.change(role(), { target: { value: 'Ferrywoman' } });
            expect(fireEvent.click(inAppLink())).toBe(true);
            expect(confirm).not.toHaveBeenCalled();
            confirm.mockRestore();
        });

        it('any other way out (back, the palette) keeps the edits, never sends them, and the page comes back with them', async () => {
            const { requests, unmount } = await inConflict();
            fireEvent.change(screen.getByTestId('field-input-want'), { target: { value: 'To cross' } });
            unmount();
            await elapse(AUTOSAVE_DEBOUNCE_MS * 3);
            expect(requests).toHaveLength(1); // no doomed save on the way out
            // Back on the element: the edits and the conflict are there, and "Keep my edits" saves them.
            const { requests: after } = mockFetch({ [`PUT ${FIELDS}`]: saved(6, { role: 'Ferrywoman', want: 'To cross' }) });
            mount();
            expect(screen.getByTestId('version-conflict')).toHaveTextContent('It is now at version 5');
            expect(role().value).toBe('Ferrywoman');
            expect((screen.getByTestId('field-input-want') as HTMLInputElement).value).toBe('To cross');
            await elapse(AUTOSAVE_DEBOUNCE_MS * 3);
            expect(after).toHaveLength(0);
            fireEvent.click(screen.getByRole('button', { name: 'Keep my edits' }));
            await elapse(0);
            expect(after.map((r) => r.body)).toEqual([
                {
                    fields: [
                        { key: 'role', value: 'Ferrywoman' },
                        { key: 'want', value: 'To cross' },
                    ],
                    baseVersion: 5,
                },
            ]);
            expect(screen.queryByTestId('version-conflict')).toBeNull();
        });

        it('a save sent on the way out that is overtaken is kept too, not dropped', async () => {
            const { requests } = mockFetch({ [`PUT ${FIELDS}`]: conflict });
            const { unmount } = mount();
            fireEvent.change(role(), { target: { value: 'Smuggler' } });
            unmount(); // mid-debounce: the way-out save is sent, and refused
            await elapse(0);
            expect(requests).toHaveLength(1);
            mockFetch({});
            mount();
            expect(screen.getByTestId('version-conflict')).toBeInTheDocument();
            expect(role().value).toBe('Smuggler');
        });
    });

    it('the notice has no axe violations', async () => {
        jest.useRealTimers();
        mockFetch({ [`PUT ${FIELDS}`]: conflict });
        const { container } = mount();
        fireEvent.change(role(), { target: { value: 'Ferrywoman' } });
        await screen.findByTestId('version-conflict', {}, { timeout: 3_000 });
        expect(await axe(container)).toHaveNoViolations();
    });
});

describe('the board of a large book', () => {
    it('shows the aggregate count and completeness, and "Show more" pages the kind by its cursor', async () => {
        const first = Array.from({ length: 3 }, (_, i) => entry(`e${i}`, `Name ${i}`, 1));
        const board = boardOf(first, { CHARACTER: { entryCount: 120, filledFieldCount: 240, nextCursor: 'cursor-1' } });
        const { requests } = mockFetch({
            [`GET ${API}/elements?kind=CHARACTER&after=cursor-1`]: { json: { elements: [entry('e9', 'Name 9', 2)], nextCursor: null } },
        });
        render(
            <>
                <BookBoard workspaceSlug={SLUG} book={BOOK} kinds={KINDS} board={board} canEdit />
                <Toaster />
            </>,
        );
        const card = document.querySelector('[data-kind="CHARACTER"]') as HTMLElement;
        expect(card).toHaveTextContent('120 entries');
        const fields = KINDS.find((k) => k.kind === 'CHARACTER')!.fieldCount;
        expect(within(card).getByRole('progressbar')).toHaveAttribute('max', String(fields * 120));
        expect(within(card).getByRole('progressbar')).toHaveAttribute('value', '240');
        expect(card).toHaveTextContent('Showing 3 of 120');
        fireEvent.click(within(card).getByRole('button', { name: 'Show more' }));
        expect(await within(card).findByRole('link', { name: 'Name 9' })).toBeInTheDocument();
        expect(requests.map((r) => r.url)).toEqual([`${API}/elements?kind=CHARACTER&after=cursor-1`]);
        expect(within(card).queryByRole('button', { name: 'Show more' })).toBeNull();
    });
});

describe('deleting a book', () => {
    function mount(canDeleteBook = true) {
        return render(
            <>
                <BookBoard workspaceSlug={SLUG} book={BOOK} kinds={KINDS} board={boardOf([])} canEdit canDeleteBook={canDeleteBook} />
                <Toaster />
            </>,
        );
    }

    it('is offered only to a viewer the server says may delete', () => {
        mount(false);
        expect(screen.queryByRole('button', { name: 'Delete book' })).toBeNull();
    });

    it('offers the export first, and deletes only once the title is typed exactly', async () => {
        const { requests } = mockFetch({
            [`DELETE ${API}`]: { json: { book: { id: BOOK.id, title: BOOK.title, deletedAt: '2026-11-19T10:00:00.000Z', restorableUntil: '2026-12-19T10:00:00.000Z' } } },
        });
        mount();
        fireEvent.click(screen.getByRole('button', { name: 'Delete book' }));
        const dialog = await screen.findByRole('dialog');
        const exportFirst = within(dialog).getByTestId('delete-book-export');
        expect(within(exportFirst).getByRole('button', { name: 'Export Markdown' })).toBeInTheDocument();
        expect(within(exportFirst).getByRole('button', { name: 'Export PDF' })).toBeInTheDocument();
        // The export section comes before the confirmation in reading order.
        const confirm = within(dialog).getByLabelText(/Type the book’s title to confirm/);
        expect(exportFirst.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        const submit = within(dialog).getByRole('button', { name: 'Delete book' });
        expect(submit).toBeDisabled();
        fireEvent.change(confirm, { target: { value: 'the salt roads' } });
        expect(submit).toBeDisabled();
        fireEvent.change(confirm, { target: { value: 'The Salt  Roads' } });
        expect(submit).toBeDisabled();
        // Spaces at the ends are not part of any title (stored titles are trimmed).
        fireEvent.change(confirm, { target: { value: `  ${BOOK.title} ` } });
        expect(submit).toBeEnabled();
        fireEvent.change(confirm, { target: { value: BOOK.title } });
        expect(submit).toBeEnabled();
        expect(requests).toHaveLength(0);
        fireEvent.click(submit);
        await waitFor(() => expect(push).toHaveBeenCalledWith('/w/ada/books'));
        expect(requests).toEqual([{ method: 'DELETE', url: API, body: undefined }]);
        expect(await screen.findByText(/You can restore it from Recently deleted until/)).toBeInTheDocument();
    });

    it('the dialog has no axe violations', async () => {
        mockFetch({});
        mount();
        fireEvent.click(screen.getByRole('button', { name: 'Delete book' }));
        expect(await axe(await screen.findByRole('dialog'))).toHaveNoViolations();
    });
});

describe('the books list and the recently deleted', () => {
    it('says when the list is cut, and links the OWNER to Recently deleted', () => {
        render(<BooksList workspaceSlug={SLUG} books={[BOOK]} truncated canEdit canManageDeleted />);
        expect(screen.getByText('Showing the 1 most recently updated books')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Recently deleted' })).toHaveAttribute('href', '/w/ada/deleted-books');
    });

    it('offers no Recently deleted to anyone else', () => {
        render(<BooksList workspaceSlug={SLUG} books={[BOOK]} canEdit />);
        expect(screen.queryByRole('link', { name: 'Recently deleted' })).toBeNull();
    });

    it('restores a deleted book and opens it', async () => {
        const { requests } = mockFetch({ [`POST /api/w/${SLUG}/deleted-books/book_1/restore`]: { json: { book: BOOK } } });
        render(
            <>
                <DeletedBooksList
                    workspaceSlug={SLUG}
                    books={[{ id: 'book_1', title: BOOK.title, deletedAt: '2026-11-10T10:00:00.000Z', restorableUntil: '2026-12-10T10:00:00.000Z' }]}
                />
                <Toaster />
            </>,
        );
        expect(screen.getByRole('heading', { level: 1, name: 'Recently deleted' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Restore The Salt Roads' }));
        await waitFor(() => expect(push).toHaveBeenCalledWith('/w/ada/books/book_1'));
        expect(requests).toEqual([{ method: 'POST', url: `/api/w/${SLUG}/deleted-books/book_1/restore`, body: undefined }]);
    });
});
