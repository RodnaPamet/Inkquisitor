/**
 * The element page's relations panel, its delete, and the read-only page a
 * reader gets (Phase 1.2).
 *
 *   - the picker offers only relation types valid for the element's kind,
 *     then only the book's elements of a kind that type allows;
 *   - a relation another kind declares is sent from the other element;
 *   - removing a relation and deleting the element follow the undo toast:
 *     nothing is sent until the window closes, and Undo sends nothing;
 *   - a READER gets values as text and no edit, create, restore, relate or
 *     delete affordance.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';

const push = jest.fn();
const refresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push, refresh, replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/elements/el_1',
    useSearchParams: () => new URLSearchParams(),
}));

import { ElementPage } from '@/components/bible/ElementPage';
import type { RelationView } from '@/app-layer/usecases/bible-elements';
import { API, elementView, mockFetch, pageProps, versionMeta } from '../helpers/bible-ui';

beforeAll(() => {
    Document.prototype.elementFromPoint = () => null;
});
beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
});

const EL = `${API}/elements/el_1`;
const MEMBER_OF: RelationView = {
    id: 'rel_1',
    direction: 'outgoing',
    type: 'member_of',
    label: 'member of',
    other: { id: 'el_guild', kind: 'FACTION', name: 'The Tidewardens', slug: 'the-tidewardens' },
    note: null,
};

function mount(props = pageProps()) {
    return render(
        <>
            <ElementPage {...props} />
            <Toaster />
        </>,
    );
}

const panel = () => screen.getByTestId('relations-panel');

async function pick(user: ReturnType<typeof userEvent.setup>, triggerId: string, option: string) {
    await user.click(document.getElementById(triggerId)!);
    await user.click(await screen.findByRole('option', { name: new RegExp(`^${option}`) }));
}

describe('relations', () => {
    it('shows each relation from this end, linking to the other element', () => {
        mockFetch({});
        mount(pageProps({ element: elementView({ relations: [MEMBER_OF] }) }));
        const row = panel().querySelector('[data-relation-id="rel_1"]') as HTMLElement;
        expect(row).toHaveTextContent('member of The Tidewardens (Faction)');
        expect(within(row).getByRole('link', { name: 'The Tidewardens' })).toHaveAttribute('href', '/w/ada/books/book_1/elements/el_guild');
    });

    it('offers only the relation types valid for this kind, then only elements of a kind the type allows', async () => {
        mockFetch({});
        const user = userEvent.setup();
        mount();
        await user.click(document.getElementById('relation-type')!);
        const types = (await screen.findAllByRole('option')).map((o) => o.textContent);
        // CHARACTER's own types, the inverse of one CHARACTER declares towards itself, and the built-in one.
        expect(types).toEqual(expect.arrayContaining(['member of', 'mentor of', 'mentored by', 'related to']));
        // A type between two other kinds (a SETTING's, between settings) is not offered, from either end.
        expect(types).not.toContain('part of');
        expect(types).not.toContain('contains');

        await user.click(screen.getByRole('option', { name: 'member of' }));
        await user.click(document.getElementById('relation-other')!);
        const others = (await screen.findAllByRole('option')).map((o) => o.textContent);
        expect(others).toEqual(['The TidewardensFaction']);
    });

    it('adds an outgoing relation from this element, then re-reads the element', async () => {
        const { requests } = mockFetch({
            [`POST ${API}/relations`]: { status: 201, json: { relation: { id: 'rel_2' } } },
            [`GET ${EL}`]: { json: { element: elementView({ relations: [MEMBER_OF] }) } },
        });
        const user = userEvent.setup();
        mount();
        await pick(user, 'relation-type', 'member of');
        await pick(user, 'relation-other', 'The Tidewardens');
        await user.click(screen.getByRole('button', { name: 'Link' }));
        await waitFor(() => expect(panel()).toHaveTextContent('member of The Tidewardens'));
        expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
            ['POST', `${API}/relations`, { fromElementId: 'el_1', toElementId: 'el_guild', type: 'member_of' }],
            ['GET', EL, undefined],
        ]);
    });

    it('sends a relation another kind declares from the other element', async () => {
        const { requests } = mockFetch({
            [`POST ${API}/relations`]: { status: 201, json: { relation: { id: 'rel_3' } } },
            [`GET ${EL}`]: { json: { element: elementView() } },
        });
        const user = userEvent.setup();
        mount();
        await pick(user, 'relation-type', 'mentored by');
        await pick(user, 'relation-other', 'Jon');
        await user.click(screen.getByRole('button', { name: 'Link' }));
        await waitFor(() => expect(requests[0]?.body).toEqual({ fromElementId: 'el_jon', toElementId: 'el_1', type: 'mentor_of' }));
    });

    it('words a refusal from its reason', async () => {
        mockFetch({ [`POST ${API}/relations`]: { status: 409, json: { error: { code: 'CONFLICT', message: 'x', details: { reason: 'RELATION_EXISTS' } } } } });
        const user = userEvent.setup();
        mount();
        await pick(user, 'relation-type', 'member of');
        await pick(user, 'relation-other', 'The Tidewardens');
        await user.click(screen.getByRole('button', { name: 'Link' }));
        expect(await within(panel()).findByRole('alert')).toHaveTextContent('These two entries are already related that way.');
    });
});

describe('undo-toast removals', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('removing a relation hides it at once and sends DELETE only when the window closes', async () => {
        const { requests } = mockFetch({
            [`DELETE ${API}/relations/rel_1`]: { json: { id: 'rel_1' } },
            [`GET ${EL}`]: { json: { element: elementView() } },
        });
        mount(pageProps({ element: elementView({ relations: [MEMBER_OF] }) }));
        fireEvent.click(within(panel()).getByRole('button', { name: 'Remove "member of The Tidewardens"' }));
        expect(panel().querySelector('[data-relation-id="rel_1"]')).toBeNull();
        expect(requests).toHaveLength(0);
        await act(async () => {
            jest.advanceTimersByTime(6000);
        });
        expect(requests[0]).toMatchObject({ method: 'DELETE', url: `${API}/relations/rel_1` });
    });

    it('deleting the element pauses editing, sends nothing on Undo, and deletes then leaves after the window', async () => {
        const { requests } = mockFetch({ [`DELETE ${EL}`]: { json: { id: 'el_1' } } });
        mount();
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(screen.getByText(/will be deleted when the undo window closes/)).toBeInTheDocument();
        expect(screen.queryByTestId('field-input-role')).toBeNull();
        fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
        await act(async () => {
            jest.advanceTimersByTime(6000);
        });
        expect(requests).toHaveLength(0);
        expect(screen.getByTestId('field-input-role')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await act(async () => {
            jest.advanceTimersByTime(4000);
        });
        expect(requests).toHaveLength(0);
        await act(async () => {
            jest.advanceTimersByTime(2000);
        });
        expect(requests).toEqual([{ method: 'DELETE', url: EL, body: undefined }]);
        expect(push).toHaveBeenCalledWith('/w/ada/books/book_1');
    });
});

describe('a reader', () => {
    const readerProps = () =>
        pageProps({
            canEdit: false,
            element: elementView({ values: { role: 'Ferrywoman', prominence: 'major', wound: '<p>Lost the boat</p>' }, relations: [MEMBER_OF] }),
        });

    it('sees every value as text, and no control that edits', () => {
        mockFetch({});
        mount(readerProps());
        expect(screen.queryAllByRole('textbox')).toHaveLength(0);
        expect(screen.queryByRole('combobox')).toBeNull();
        expect(screen.queryByTestId('save-status')).toBeNull();
        const fields = screen.getByTestId('element-fields');
        expect(fields).toHaveTextContent('Ferrywoman');
        expect(fields).toHaveTextContent('Major presence');
        expect(fields).toHaveTextContent('Lost the boat');
        expect(fields).not.toHaveTextContent('<p>');
    });

    it('gets no delete, relate or remove affordance', () => {
        mockFetch({});
        mount(readerProps());
        expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
        expect(screen.queryByTestId('relation-picker')).toBeNull();
        expect(within(panel()).queryByRole('button')).toBeNull();
        expect(panel()).toHaveTextContent('member of The Tidewardens');
    });

    it('can read the history but restore nothing', async () => {
        mockFetch({ [`GET ${EL}/versions?take=50`]: { json: { versions: [versionMeta(3), versionMeta(2), versionMeta(1)] } } });
        mount(readerProps());
        fireEvent.click(screen.getByRole('tab', { name: 'History' }));
        const history = await screen.findByTestId('history-panel');
        expect(within(history).getAllByRole('listitem')).toHaveLength(3);
        expect(within(history).queryByRole('button', { name: /Restore/ })).toBeNull();
    });
});
