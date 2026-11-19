/**
 * The Books page — a placeholder until Phase 1. Signed out it says so; inside
 * a workspace it shows the page's empty state, under the lifted
 * `<PageHeader>`. (Settings became a real page in 0.3: its sessions section is
 * tests/rendered/sessions-panel.test.tsx.)
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({ usePathname: () => '/w/ada/books' }));

import BooksPage from '@/app/w/[workspaceSlug]/books/page';
import { WorkspaceProvider, type WorkspaceContextValue } from '@/lib/workspace/workspace-context';

const WORKSPACE: WorkspaceContextValue = {
    workspaceId: 'ws_1',
    workspaceSlug: 'ada',
    workspaceName: "Ada's books",
    role: 'OWNER',
    userId: 'user_1',
    userName: 'Ada Quill',
};

describe.each([
    ['books', BooksPage, 'Books', 'Sign in to see your books.', 'No books yet.'],
] as const)('the %s page', (name, Page, title, signedOut, empty) => {
    it('names itself in an H1', () => {
        render(<Page />);
        expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
        expect(screen.getByTestId(`placeholder-${name}`)).toBeInTheDocument();
    });

    it('signed out, says sign in', () => {
        render(
            <WorkspaceProvider value={null}>
                <Page />
            </WorkspaceProvider>,
        );
        expect(screen.getByText(signedOut)).toBeInTheDocument();
        expect(screen.queryByText(empty)).toBeNull();
    });

    it('inside a workspace, shows the empty state', () => {
        render(
            <WorkspaceProvider value={WORKSPACE}>
                <Page />
            </WorkspaceProvider>,
        );
        expect(screen.getByText(empty)).toBeInTheDocument();
        expect(screen.queryByText(signedOut)).toBeNull();
    });
});
