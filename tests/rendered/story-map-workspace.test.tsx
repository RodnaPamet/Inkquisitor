/**
 * The map page's body (Phase 3.1): the editor arrives through `next/dynamic`
 * behind the error boundary, and "Try again" after a failed chunk load asks
 * for the chunk again rather than replaying the failure.
 */
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/w/ada/books/book_1/maps/plot',
}));

// What `next/dynamic` IS in an App Router build (create-compiler-aliases.js
// aliases it to `next/dist/api/app-dynamic`); Jest would otherwise load the
// Pages Router's loadable, which handles a failed load differently.
jest.mock('next/dynamic', () => jest.requireActual('next/dist/shared/lib/app-dynamic'));

let mockChunkLoads = 0;
let mockChunkFails = true;
// The editor chunk: the first load fails as a network blip would, later loads succeed.
jest.mock('@/components/canvas/StoryMapEditor', () => {
    mockChunkLoads += 1;
    if (mockChunkFails) throw new Error('Loading chunk 399 failed');
    return { __esModule: true, default: () => <p>the editor</p> };
});

import { act, fireEvent, render, screen } from '@testing-library/react';

import { StoryMapWorkspace } from '@/components/canvas/StoryMapWorkspace';

/** Let the chunk's promise settle and React render what follows, inside act. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

const EMPTY_MAP = { kind: 'PLOT', version: 0, nodes: [], edges: [], freeform: [], relations: [], relationsTruncated: false } as const;

it('a failed editor chunk shows the boundary, and Try again loads the chunk afresh and shows the editor', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    render(
        <StoryMapWorkspace
            workspaceSlug="ada"
            book={{ id: 'book_1', title: 'A book' }}
            kind="PLOT"
            kindSlug="plot"
            initialMap={EMPTY_MAP as never}
            kindLabels={{}}
            fieldCounts={{}}
            relationOptions={{}}
            fieldDefs={{}}
            canEdit
        />,
    );
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('The canvas could not be shown');
    const failedLoads = mockChunkLoads;
    expect(failedLoads).toBeGreaterThan(0);

    mockChunkFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.getByText('the editor')).toBeInTheDocument();
    expect(mockChunkLoads).toBeGreaterThan(failedLoads);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    spy.mockRestore();
});
