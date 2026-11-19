/**
 * The element page's History tab (Phase 1.2): versions newest first with
 * their source; a diff between any two picked versions, read as labelled
 * lines rather than JSON; and restore, which calls the restore API, then
 * re-reads the element and the history so the page shows the new version.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Toaster } from 'sonner';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/elements/el_1',
    useSearchParams: () => new URLSearchParams(),
}));

import { ElementPage } from '@/components/bible/ElementPage';
import { API, elementView, mockFetch, pageProps, versionMeta, versionView } from '../helpers/bible-ui';

beforeAll(() => {
    Document.prototype.elementFromPoint = () => null;
});

const EL = `${API}/elements/el_1`;
const VERSIONS = [versionMeta(3), versionMeta(2, { source: 'IMPORT' }), versionMeta(1, { changeSummary: 'First draft' })];
const SNAPSHOTS = {
    1: versionView(1, { role: 'Protagonist' }),
    2: versionView(2, { role: 'Protagonist', want: 'To reach the far shore', prominence: 'major' }),
    3: versionView(3, { role: 'Ferrywoman', want: 'To reach the far shore', prominence: 'major', agency: 4 }, { status: 'IN_PROGRESS' }),
};

function routes(extra: Record<string, unknown> = {}) {
    return {
        [`GET ${EL}/versions?take=50`]: { json: { versions: VERSIONS } },
        [`GET ${EL}/versions/1`]: { json: { version: SNAPSHOTS[1] } },
        [`GET ${EL}/versions/2`]: { json: { version: SNAPSHOTS[2] } },
        [`GET ${EL}/versions/3`]: { json: { version: SNAPSHOTS[3] } },
        ...(extra as Record<string, { json: unknown }>),
    };
}

async function openHistory() {
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    return screen.findByTestId('history-panel');
}

const diffBody = () => screen.getByTestId('version-diff-body');
const added = () => Array.from(diffBody().querySelectorAll('[data-testid="version-diff-added"] > span')).map((s) => s.textContent?.replace(/^\+/, ''));
const removed = () => Array.from(diffBody().querySelectorAll('[data-testid="version-diff-removed"] > span')).map((s) => s.textContent?.replace(/^−/, ''));

it('lists the versions newest first, each with its source', async () => {
    mockFetch(routes());
    render(<ElementPage {...pageProps({ element: elementView({ versionNumber: 3 }) })} />);
    const panel = await openHistory();
    // Opening the tab re-reads the history (it moves with every save).
    await waitFor(() => expect(within(panel).getByTestId('version-list')).toHaveTextContent('Import'));
    const rows = within(within(panel).getByTestId('version-list')).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-version'))).toEqual(['3', '2', '1']);
    expect(rows[0]).toHaveTextContent('Manual edit');
    expect(rows[0]).toHaveTextContent('Current');
    expect(rows[1]).toHaveTextContent('Import');
    expect(rows[2]).toHaveTextContent('First draft');
});

it('diffs the previous and the latest version by default, as readable lines', async () => {
    mockFetch(routes());
    render(<ElementPage {...pageProps()} />);
    await openHistory();
    await waitFor(() => expect(screen.getByTestId('history-diff')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByTestId('version-diff-from')).toHaveValue('2');
    expect(screen.getByTestId('version-diff-to')).toHaveValue('3');
    expect(removed()).toEqual(['Status: Draft', 'Role in the story: Protagonist']);
    expect(added()).toEqual(['Status: In progress', 'Role in the story: Ferrywoman', 'Drive to act: 4 of 5']);
    expect(diffBody().textContent).not.toContain('{');
});

it('diffs any two versions the author picks, fetching the one it has not read', async () => {
    const { requests } = mockFetch(routes());
    render(<ElementPage {...pageProps()} />);
    await openHistory();
    await screen.findByTestId('version-diff-body');
    expect(requests.some((r) => r.url === `${EL}/versions/1`)).toBe(false);

    fireEvent.change(screen.getByTestId('version-diff-from'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('version-diff-to'), { target: { value: '2' } });
    await waitFor(() => expect(requests.some((r) => r.url === `${EL}/versions/1`)).toBe(true));
    await waitFor(() => expect(screen.getByTestId('history-diff')).toHaveAttribute('aria-busy', 'false'));
    expect(requests.filter((r) => r.url === `${EL}/versions/1`)).toHaveLength(1);
    expect(added()).toEqual(['Prominence: Major presence', 'Conscious want: To reach the far shore']);
    expect(removed()).toEqual([]);
});

it('restore calls the restore API, then shows the restored values and the new version', async () => {
    const restoredElement = elementView({ versionNumber: 4, values: { role: 'Protagonist' } });
    let restored = false;
    const { requests } = mockFetch({
        ...routes(),
        [`POST ${EL}/versions/1/restore`]: () => {
            restored = true;
            return { status: 201, json: { restore: { version: versionMeta(4, { restoredFromVersion: 1 }), restoredFromVersion: 1, skippedFieldKeys: [], slugKept: false } } };
        },
        [`GET ${EL}`]: { json: { element: restoredElement } },
        [`GET ${EL}/versions?take=50`]: () => ({ json: { versions: restored ? [versionMeta(4, { restoredFromVersion: 1, changeSummary: 'Restored version 1' }), ...VERSIONS] : VERSIONS } }),
        [`GET ${EL}/versions/4`]: { json: { version: { ...versionView(4, { role: 'Protagonist' }), restoredFromVersion: 1 } } },
    });
    render(
        <>
            <ElementPage {...pageProps({ element: elementView({ versionNumber: 3, values: { role: 'Ferrywoman' } }) })} />
            <Toaster />
        </>,
    );
    const panel = await openHistory();
    await screen.findByTestId('version-diff-body');
    // The current version offers no restore; an older one does.
    expect(within(panel).queryByTestId('restore-3')).toBeNull();

    await act(async () => {
        fireEvent.click(within(panel).getByTestId('restore-1'));
    });
    await screen.findByText(/Restored from version 1/);

    const order = requests.map((r) => `${r.method} ${r.url}`);
    const restoreAt = order.indexOf(`POST ${EL}/versions/1/restore`);
    expect(restoreAt).toBeGreaterThan(-1);
    expect(order.slice(restoreAt + 1)).toEqual(expect.arrayContaining([`GET ${EL}`, `GET ${EL}/versions?take=50`]));
    const rows = within(within(panel).getByTestId('version-list')).getAllByRole('listitem');
    expect(rows[0]).toHaveAttribute('data-version', '4');
    expect(rows[0]).toHaveTextContent('Current');

    // Back on the Fields tab, the restored value is what the editor holds.
    fireEvent.click(screen.getByRole('tab', { name: 'Fields' }));
    expect(screen.getByTestId('field-input-role')).toHaveValue('Protagonist');
});

it('a version that failed to load is fetched again when picked, and only its own comparison says it failed', async () => {
    mockFetch({ ...routes(), [`GET ${EL}/versions/2`]: { status: 500, json: {} } });
    render(<ElementPage {...pageProps()} />);
    await openHistory();
    // The default comparison is 2 → 3, and version 2 does not arrive.
    expect(await screen.findByText('The versions could not be loaded.')).toBeInTheDocument();

    // Comparing 1 → 3 instead involves no failed version: it loads, and no failure is reported.
    fireEvent.change(screen.getByTestId('version-diff-from'), { target: { value: '1' } });
    await waitFor(() => expect(screen.getByTestId('history-diff')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByText('The versions could not be loaded.')).toBeNull();

    // Picking version 2 again fetches it again; while it loads the page says so, not that it failed.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = mockFetch({
        ...routes(),
        [`GET ${EL}/versions/2`]: async () => {
            await gate;
            return { json: { version: SNAPSHOTS[2] } };
        },
    });
    fireEvent.change(screen.getByTestId('version-diff-from'), { target: { value: '2' } });
    await waitFor(() => expect(slow.requests.some((r) => r.url === `${EL}/versions/2`)).toBe(true));
    expect(screen.getByText('Loading the versions…')).toBeInTheDocument();
    expect(screen.queryByText('The versions could not be loaded.')).toBeNull();
    await act(async () => {
        release();
    });
    await waitFor(() => expect(screen.getByTestId('history-diff')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByText('The versions could not be loaded.')).toBeNull();
});
