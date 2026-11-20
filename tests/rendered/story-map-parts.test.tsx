/**
 * The story canvas's parts outside the editor (Phase 3.1): the error
 * boundary, the conflict notice, the history (Compare, Restore under the
 * lock, a reader's view) and the diff overlay.
 */
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/maps/plot',
}));

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { CanvasDiffOverlay } from '@/components/canvas/CanvasDiffOverlay';
import { CanvasErrorBoundary } from '@/components/canvas/CanvasErrorBoundary';
import { CanvasHistorySidebar } from '@/components/canvas/CanvasHistorySidebar';
import { MapConflictNotice } from '@/components/canvas/MapConflictNotice';
import type { MapState } from '@/lib/canvas/map-state';
import { mockFetch } from '../helpers/bible-ui';

const MAP = '/api/w/ada/books/book_1/maps/plot';

describe('CanvasErrorBoundary', () => {
    function Boom({ explode }: { explode: { current: boolean } }) {
        if (explode.current) throw new Error('chunk failed to load: SECRET-RECORD-TEXT');
        return <p>canvas here</p>;
    }

    it('a canvas that throws leaves the page standing, says the map is safe, never shows the error, and tries again', () => {
        const explode = { current: true };
        const onError = jest.fn();
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        render(
            <main>
                <h1>Plot board</h1>
                <CanvasErrorBoundary onError={onError}>
                    <Boom explode={explode} />
                </CanvasErrorBoundary>
            </main>,
        );
        spy.mockRestore();
        expect(screen.getByRole('heading', { name: 'Plot board' })).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('The canvas could not be shown');
        expect(screen.getByRole('alert')).toHaveTextContent('Nothing was lost');
        expect(document.body).not.toHaveTextContent('SECRET-RECORD-TEXT');
        expect(onError).toHaveBeenCalledTimes(1);

        explode.current = false;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(screen.getByText('canvas here')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
});

describe('MapConflictNotice', () => {
    it('a version conflict offers Reload and saving over the newer version', () => {
        const onReload = jest.fn();
        const onSaveMine = jest.fn();
        render(<MapConflictNotice cause="version" onReload={onReload} onSaveMine={onSaveMine} />);
        expect(screen.getByRole('alert')).toHaveTextContent('your unsaved changes here will be lost');
        fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save mine over it' }));
        expect(onReload).toHaveBeenCalledTimes(1);
        expect(onSaveMine).toHaveBeenCalledTimes(1);
    });

    it('a deletion in the bible offers Reload only: the edits name something gone', () => {
        render(<MapConflictNotice cause="gone" onReload={jest.fn()} onSaveMine={jest.fn()} />);
        expect(screen.getByRole('alert')).toHaveTextContent('deleted from the bible');
        expect(screen.queryByRole('button', { name: 'Save mine over it' })).not.toBeInTheDocument();
    });
});

const SNAPSHOTS = {
    snapshots: [
        { version: 3, nodeCount: 2, edgeCount: 1, restoredFromVersion: 1, fromBibleDeletion: false, createdAt: '2026-11-20T10:00:00.000Z', createdByName: 'Ada' },
        { version: 2, nodeCount: 2, edgeCount: 0, restoredFromVersion: null, fromBibleDeletion: true, createdAt: '2026-11-20T09:00:00.000Z', createdByName: 'Ada' },
        { version: 1, nodeCount: 1, edgeCount: 0, restoredFromVersion: null, fromBibleDeletion: false, createdAt: '2026-11-20T08:00:00.000Z', createdByName: null },
    ],
    truncated: false,
};

function history(over: Partial<React.ComponentProps<typeof CanvasHistorySidebar>> = {}) {
    const props = {
        workspaceSlug: 'ada',
        bookId: 'book_1',
        kind: 'plot',
        currentVersion: 3,
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

describe('CanvasHistorySidebar', () => {
    it('lists the saves newest first, marks the current one, and offers Compare and Restore on the others', async () => {
        mockFetch({ [`GET ${MAP}/snapshots`]: { json: SNAPSHOTS } });
        const props = history();
        const rows = await screen.findAllByTestId('canvas-history-row');
        expect(rows.map((r) => r.getAttribute('data-version'))).toEqual(['3', '2', '1']);
        expect(rows[0]).toHaveTextContent('Current');
        expect(rows[0]).toHaveTextContent('Restored from version 1');
        expect(rows[0]).not.toHaveTextContent('Restore\b');
        // A version a bible deletion made (D20) says so, and names who deleted.
        expect(rows[1]).toHaveTextContent('An entry or relation was deleted from the bible');
        expect(rows[1]).toHaveTextContent('Ada');
        expect(rows[0]).not.toHaveTextContent('deleted from the bible');
        expect(screen.getAllByTestId('canvas-history-restore')).toHaveLength(2);
        fireEvent.click(screen.getAllByTestId('canvas-history-diff')[0]);
        expect(props.onDiffRequest).toHaveBeenCalledWith(2);
    });

    it('restores after a confirmation, naming the version it read; a stale one is the host’s conflict', async () => {
        const { requests } = mockFetch({
            [`GET ${MAP}/snapshots`]: { json: SNAPSHOTS },
            [`POST ${MAP}/snapshots/2/restore`]: { status: 409, json: { error: { code: 'CONFLICT', message: 'x', details: { reason: 'VERSION_CONFLICT', currentVersion: 4 } } } },
        });
        const props = history();
        fireEvent.click((await screen.findAllByTestId('canvas-history-restore'))[0]);
        fireEvent.click(await screen.findByTestId('canvas-history-confirm-restore'));
        await waitFor(() => expect(props.onConflict).toHaveBeenCalledWith(4));
        expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ expectedVersion: 3 });
        expect(props.onRestored).not.toHaveBeenCalled();
    });

    it('a reader sees the history and Compare, never Restore', async () => {
        mockFetch({ [`GET ${MAP}/snapshots`]: { json: SNAPSHOTS } });
        history({ canRestore: false });
        await screen.findAllByTestId('canvas-history-row');
        expect(screen.queryByTestId('canvas-history-restore')).not.toBeInTheDocument();
        expect(screen.getAllByTestId('canvas-history-diff')).toHaveLength(2);
    });

    it('a map nobody has saved says so', async () => {
        mockFetch({ [`GET ${MAP}/snapshots`]: { json: { snapshots: [], truncated: false } } });
        history({ currentVersion: 0 });
        expect(await screen.findByTestId('canvas-history-empty')).toHaveTextContent('No saves yet');
    });
});

describe('CanvasDiffOverlay', () => {
    const current: MapState = {
        nodes: [
            { elementId: 'a', x: 50, y: 0, w: 100, h: 50, lane: null },
            { elementId: 'c', x: 0, y: 0, w: 100, h: 50, lane: null },
        ],
        edges: [],
        freeform: [],
    };

    it('names each change by the element it draws, and an element no longer on the map as such', async () => {
        mockFetch({
            [`GET ${MAP}/snapshots/2`]: {
                json: {
                    snapshot: {
                        version: 2,
                        nodes: [
                            { elementId: 'a', x: 0, y: 0, w: 100, h: 50, lane: null },
                            { elementId: 'b', x: 0, y: 0, w: 100, h: 50, lane: null },
                        ],
                        edges: [{ relationId: 'r1', sourceElementId: 'a', targetElementId: 'b' }],
                        freeform: [],
                    },
                },
            },
        });
        await act(async () => {
            render(
                <CanvasDiffOverlay
                    open
                    onOpenChange={jest.fn()}
                    workspaceSlug="ada"
                    bookId="book_1"
                    kind="plot"
                    targetVersion={2}
                    current={current}
                    elementNames={new Map([['a', 'Ada'], ['c', 'Cyd']])}
                    relationLabels={new Map([['r1', 'mentors']])}
                />,
            );
        });
        const rows = await screen.findAllByTestId('canvas-diff-node');
        expect(rows.map((r) => [r.textContent, r.getAttribute('data-class')])).toEqual([
            ['AdaMoved', 'moved'],
            ['An element no longer on the mapRemoved', 'removed'],
            ['CydAdded', 'added'],
        ]);
        expect(screen.getByTestId('canvas-diff-edge')).toHaveTextContent('mentors');
        // One chip per kind of change: a node added, removed and moved, an edge removed.
        expect(within(screen.getByTestId('canvas-diff-summary')).getAllByRole('listitem')).toHaveLength(4);
    });
});
