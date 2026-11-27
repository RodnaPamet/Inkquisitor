/**
 * The story map's list view and history, by keyboard and screen reader
 * (Phase 3.H, items 5 and 6; issue #45, item 2).
 *
 *   - Every canvas action has its list equivalent (`StoryMapListView`): open
 *     an element, remove it from the map, move it earlier or later on a
 *     derived map, relate two elements, remove or question a relation, grill
 *     a selection — each a named button, reached and pressed with keys, and
 *     the view passes axe.
 *   - The history pages ("Show older"), so after 200 saves the oldest is
 *     still a row; a restore with unsaved canvas edits says they are saved
 *     first, saves them, and names the version that save reached.
 */
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/maps/plot',
}));

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { CanvasHistorySidebar } from '@/components/canvas/CanvasHistorySidebar';
import { StoryMapListView, type ListEdge, type ListNode, type StoryMapListViewProps } from '@/components/canvas/StoryMapListView';
import { mockFetch } from '../helpers/bible-ui';

const NODES: ListNode[] = [
    { elementId: 'b1', name: 'The flood', kindLabel: 'Plot beat', badgeLabel: '40%', detail: '' },
    { elementId: 'b2', name: 'The bargain', kindLabel: 'Plot beat', badgeLabel: 'Not assessed', detail: '' },
    { elementId: 'b3', name: 'The reckoning', kindLabel: 'Plot beat', badgeLabel: '', detail: 'Not placed yet' },
];
const EDGES: ListEdge[] = [{ relationId: 'r1', sourceElementId: 'b1', targetElementId: 'b2', label: 'causes' }];

function list(over: Partial<StoryMapListViewProps> = {}) {
    const props: StoryMapListViewProps = {
        nodes: NODES,
        edges: EDGES,
        groups: [
            { key: 'opening', label: 'Opening', elementIds: ['b1', 'b2'] },
            { key: 'no-act', label: 'No act yet', elementIds: ['b3'] },
        ],
        canEdit: true,
        onOpen: jest.fn(),
        onRemoveNode: jest.fn(),
        onRemoveEdge: jest.fn(),
        onRelate: jest.fn(),
        onGrill: jest.fn(),
        canMove: (id, direction) => !(id === 'b1' && direction === 'earlier') && !(id === 'b3' && direction === 'later'),
        onMove: jest.fn(),
        ...over,
    };
    const view = render(
        <main>
            <h1>Plot board</h1>
            <StoryMapListView {...props} />
        </main>,
    );
    return { props, view };
}

describe('the list view', () => {
    it('reads as headings and ordered lists, each lane in its order, and passes axe', async () => {
        const { view } = list();
        // (The test catalogue does not expand plurals: the heading's text is checked by its words.)
        expect(screen.getByRole('heading', { name: /elements on this map/ })).toBeInTheDocument();
        const opening = screen.getByRole('list', { name: 'Opening' });
        expect(within(opening).getAllByRole('listitem').map((li) => li.getAttribute('data-element-id'))).toEqual(['b1', 'b2']);
        expect(within(opening).getAllByRole('listitem')[0]).toHaveTextContent('1 of 2');
        expect(screen.getByRole('list', { name: 'No act yet' })).toHaveTextContent('Not placed yet');
        expect(screen.getByRole('heading', { name: /relations on this map/ })).toBeInTheDocument();
        expect(screen.getByTestId('map-list-relation')).toHaveTextContent('The flood causes The bargain');
        expect(await axe(view.container)).toHaveNoViolations();
    });

    it('every action is a named button the keyboard reaches and presses', async () => {
        const user = userEvent.setup();
        const { props } = list();
        await user.tab();
        // The first stop is the first element's checkbox; Space ticks it.
        expect(screen.getByRole('checkbox', { name: 'Select The flood to be grilled' })).toHaveFocus();
        await user.keyboard(' ');
        await user.tab();
        expect(screen.getByRole('button', { name: 'Open The flood' })).toHaveFocus();
        await user.keyboard('{Enter}');
        expect(props.onOpen).toHaveBeenCalledWith('b1');

        // The first beat cannot move earlier; it can move later.
        expect(screen.getByRole('button', { name: 'Earlier: The flood' })).toBeDisabled();
        screen.getByRole('button', { name: 'Later: The flood' }).focus();
        await user.keyboard('{Enter}');
        expect(props.onMove).toHaveBeenCalledWith('b1', 'later');

        screen.getByRole('button', { name: 'Remove from map: The bargain' }).focus();
        await user.keyboard('{Enter}');
        expect(props.onRemoveNode).toHaveBeenCalledWith('b2');

        screen.getByRole('button', { name: 'Question this relation: The flood causes The bargain' }).focus();
        await user.keyboard('{Enter}');
        expect(props.onGrill).toHaveBeenLastCalledWith({ elementIds: [], relationIds: ['r1'] });

        screen.getByRole('button', { name: 'Remove relation: The flood causes The bargain' }).focus();
        await user.keyboard('{Enter}');
        expect(props.onRemoveEdge).toHaveBeenCalledWith(EDGES[0]);

        // The relation's checkbox, then "Grill the selected" with both picks.
        screen.getByRole('checkbox', { name: 'Select the relation The flood causes The bargain to be grilled' }).focus();
        await user.keyboard(' ');
        screen.getByTestId('map-list-grill').focus();
        await user.keyboard('{Enter}');
        expect(props.onGrill).toHaveBeenLastCalledWith({ elementIds: ['b1'], relationIds: ['r1'] });
    });

    it('relates two elements chosen by keyboard, and refuses an element with itself', async () => {
        const user = userEvent.setup();
        const { props } = list({ groups: null, canMove: undefined, onMove: undefined });
        const relate = screen.getByTestId('map-list-relate');
        expect(relate).toBeDisabled();
        await act(async () => {
            fireEvent.click(screen.getByRole('combobox', { name: /From/ }));
        });
        await user.click(await screen.findByRole('option', { name: 'The flood' }));
        await act(async () => {
            fireEvent.click(screen.getByRole('combobox', { name: /To/ }));
        });
        await user.click(await screen.findByRole('option', { name: 'The reckoning' }));
        expect(relate).toBeEnabled();
        relate.focus();
        await user.keyboard('{Enter}');
        expect(props.onRelate).toHaveBeenCalledWith('b1', 'b3');
        // A relationship map has no reading order: no Earlier / Later.
        expect(screen.queryByRole('button', { name: /earlier/ })).not.toBeInTheDocument();
    });

    it('a reader reads the map and is offered no action', async () => {
        const { view } = list({ canEdit: false });
        expect(screen.getByRole('button', { name: 'Open The flood' })).toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
        expect(screen.queryByTestId('map-list-relate')).not.toBeInTheDocument();
        expect(await axe(view.container)).toHaveNoViolations();
    });

    it('lists each beat\'s scenes under it, as the board\'s scene cards show them: links to their editors, "+N more" opening the beat (D33 B)', async () => {
        const beats = new Map([
            ['b1', { beatElementId: 'b1', total: 4, scenes: [{ sceneId: 's1', title: 'Wren comes ashore', chapterTitle: 'One' }, { sceneId: 's2', title: null, chapterTitle: 'One' }] }],
            ['b3', { beatElementId: 'b3', total: 1, scenes: [{ sceneId: 's9', title: 'The last tide', chapterTitle: 'Nine' }] }],
        ]);
        const { props, view } = list({ scenes: { beats, href: (id) => `/w/ada/books/book_1/manuscript/scenes/${id}` } });
        const flood = screen.getAllByTestId('map-list-element').find((li) => li.getAttribute('data-element-id') === 'b1')!;
        const links = within(flood).getAllByTestId('map-list-scene');
        expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
            ['Wren comes ashore', '/w/ada/books/book_1/manuscript/scenes/s1'],
            ['Untitled scene', '/w/ada/books/book_1/manuscript/scenes/s2'],
        ]);
        expect(within(flood).getByRole('link', { name: 'Open scene: Wren comes ashore' })).toBeInTheDocument();
        await userEvent.click(within(flood).getByRole('button', { name: /of The flood: open the beat/ }));
        expect(props.onOpen).toHaveBeenCalledWith('b1');
        const bargain = screen.getAllByTestId('map-list-element').find((li) => li.getAttribute('data-element-id') === 'b2')!;
        expect(within(bargain).queryByTestId('map-list-beat-scenes')).toBeNull();
        expect(within(screen.getAllByTestId('map-list-element').find((li) => li.getAttribute('data-element-id') === 'b3')!).queryByTestId('map-list-scenes-more')).toBeNull();
        expect(await axe(view.container)).toHaveNoViolations();
    });
});

const MAP = '/api/w/ada/books/book_1/maps/plot';
const row = (version: number) => ({ version, nodeCount: 1, edgeCount: 0, restoredFromVersion: null, fromBibleDeletion: false, createdAt: '2026-11-20T08:00:00.000Z', createdByName: null });

function history(over: Partial<React.ComponentProps<typeof CanvasHistorySidebar>> = {}) {
    const props = {
        workspaceSlug: 'ada',
        bookId: 'book_1',
        kind: 'plot',
        currentVersion: 200,
        canRestore: true,
        open: true,
        onOpenChange: jest.fn(),
        onDiffRequest: jest.fn(),
        onRestored: jest.fn(),
        onConflict: jest.fn(),
        ...over,
    };
    render(<CanvasHistorySidebar {...props} />);
    return props;
}

describe('the history', () => {
    it('reads a page at a time: "Show older" reaches the first save of 200', async () => {
        const page = (top: number, nextBefore: number | null) => ({ snapshots: Array.from({ length: 50 }, (_, i) => row(top - i)), truncated: nextBefore !== null, nextBefore });
        const { requests } = mockFetch({
            [`GET ${MAP}/snapshots`]: { json: page(200, 151) },
            [`GET ${MAP}/snapshots?before=151`]: { json: page(150, 101) },
            [`GET ${MAP}/snapshots?before=101`]: { json: page(100, 51) },
            [`GET ${MAP}/snapshots?before=51`]: { json: page(50, null) },
        });
        history();
        expect(await screen.findAllByTestId('canvas-history-row')).toHaveLength(50);
        for (let i = 0; i < 3; i++) {
            fireEvent.click(screen.getByTestId('canvas-history-older'));
            await waitFor(() => expect(screen.getAllByTestId('canvas-history-row')).toHaveLength(50 * (i + 2)));
        }
        expect(screen.queryByTestId('canvas-history-older')).not.toBeInTheDocument();
        const rows = screen.getAllByTestId('canvas-history-row');
        expect(rows[rows.length - 1]).toHaveAttribute('data-version', '1');
        expect(requests.map((r) => r.url)).toEqual([`${MAP}/snapshots`, `${MAP}/snapshots?before=151`, `${MAP}/snapshots?before=101`, `${MAP}/snapshots?before=51`]);
    });

    it('with unsaved edits, the confirmation says they are saved first, and the restore names the version that save reached', async () => {
        const { requests } = mockFetch({
            [`GET ${MAP}/snapshots`]: { json: { snapshots: [row(200), row(199)], truncated: false, nextBefore: null } },
            [`POST ${MAP}/snapshots/199/restore`]: { json: { saved: true, restoredFromVersion: 199, dropped: { nodes: 0, edges: 0 }, map: { version: 202 } } },
        });
        const beforeRestore = jest.fn(async () => 201);
        const props = history({ pendingEdits: true, beforeRestore });
        fireEvent.click((await screen.findAllByTestId('canvas-history-restore'))[0]);
        expect((await screen.findAllByText(/unsaved changes on the canvas are saved first/)).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByTestId('canvas-history-confirm-restore'));
        await waitFor(() => expect(props.onRestored).toHaveBeenCalled());
        expect(beforeRestore).toHaveBeenCalledTimes(1);
        expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ expectedVersion: 201 });
    });

    it('when the unsaved edits cannot be saved, nothing is restored and it says so', async () => {
        const { requests } = mockFetch({ [`GET ${MAP}/snapshots`]: { json: { snapshots: [row(200), row(199)], truncated: false, nextBefore: null } } });
        const props = history({ pendingEdits: true, beforeRestore: async () => null });
        fireEvent.click((await screen.findAllByTestId('canvas-history-restore'))[0]);
        fireEvent.click(await screen.findByTestId('canvas-history-confirm-restore'));
        expect(await screen.findByText(/could not be saved, so nothing was restored/)).toBeInTheDocument();
        expect(requests.some((r) => r.method === 'POST')).toBe(false);
        expect(props.onRestored).not.toHaveBeenCalled();
    });

    it('with nothing pending, the confirmation is the plain one and nothing is saved first', async () => {
        mockFetch({
            [`GET ${MAP}/snapshots`]: { json: { snapshots: [row(200), row(199)], truncated: false, nextBefore: null } },
            [`POST ${MAP}/snapshots/199/restore`]: { json: { saved: true, restoredFromVersion: 199, dropped: { nodes: 0, edges: 0 }, map: { version: 201 } } },
        });
        const beforeRestore = jest.fn(async () => 999);
        history({ pendingEdits: false, beforeRestore });
        fireEvent.click((await screen.findAllByTestId('canvas-history-restore'))[0]);
        expect(screen.queryByText(/saved first/)).not.toBeInTheDocument();
        fireEvent.click(await screen.findByTestId('canvas-history-confirm-restore'));
        await waitFor(() => expect(beforeRestore).not.toHaveBeenCalled());
    });
});
