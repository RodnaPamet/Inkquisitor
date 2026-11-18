/**
 * The Books and Settings pages — the shell's two destinations, placeholders
 * until their features land. Signed out they say so; inside a workspace they
 * show the page's empty state. Both render the lifted `<PageHeader>`.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({ usePathname: () => '/books' }));

import BooksPage from '@/app/(app)/books/page';
import SettingsPage from '@/app/(app)/settings/page';
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
    ['settings', SettingsPage, 'Settings', 'Sign in to change your settings.', 'Nothing to configure yet.'],
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
