/**
 * `<AppShell>` over `WorkspaceContext`.
 *
 * Both of the shell's states are held here: signed out (`value={null}`, the
 * dev kitchen sink) it offers no destinations, keeps the theme toggle and
 * names nobody; inside a workspace it links to that workspace's pages under
 * `/w/<slug>/` and names the person, the workspace and the role. Sign-out
 * controls appear only when a handler is supplied (`WorkspaceAppShell`).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

const navigationMock = { pathname: '/w/ada/books' };
jest.mock('next/navigation', () => ({
    usePathname: () => navigationMock.pathname,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({}),
    useSearchParams: () => new URLSearchParams(),
}));

import { AppShell } from '@/components/layout/AppShell';
import { WorkspaceProvider, type WorkspaceContextValue } from '@/lib/workspace/workspace-context';
import { CommandPalette, CommandPaletteProvider } from '@/components/command-palette';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

const WORKSPACE: WorkspaceContextValue = {
    workspaceId: 'ws_1',
    workspaceSlug: 'ada',
    workspaceName: "Ada's books",
    role: 'EDITOR',
    userId: 'user_1',
    userName: 'Ada Quill',
};

function mount(value: WorkspaceContextValue | null, onLogout?: () => void) {
    return render(
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                <WorkspaceProvider value={value}>
                    <AppShell onLogout={onLogout}>
                        <p data-testid="page-content">Page</p>
                    </AppShell>
                </WorkspaceProvider>
                <CommandPalette />
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>,
    );
}

/** The desktop sidebar (the mobile drawer renders only when opened). */
function sidebarNav() {
    return screen.getAllByRole('navigation', { name: 'Main navigation' })[0];
}

beforeEach(() => {
    navigationMock.pathname = '/w/ada/books';
    window.localStorage.clear();
});

describe('AppShell — navigation', () => {
    it('renders the page inside the shell', () => {
        mount(null);
        expect(screen.getByTestId('page-content')).toBeInTheDocument();
    });

    it("the sidebar offers exactly Books and Settings, under the workspace's slug", () => {
        mount(WORKSPACE);
        const links = within(sidebarNav()).getAllByRole('link');
        expect(links.map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
            ['Books', '/w/ada/books'],
            ['Settings', '/w/ada/settings'],
        ]);
    });

    it('signed out, the sidebar offers no destination: every page belongs to a workspace', () => {
        mount(null);
        expect(within(sidebarNav()).queryAllByRole('link')).toEqual([]);
    });

    it('marks the current page active, and only it', () => {
        navigationMock.pathname = '/w/ada/settings';
        mount(WORKSPACE);
        const nav = sidebarNav();
        expect(within(nav).getByRole('link', { name: /Settings/ })).toHaveAttribute('aria-current', 'page');
        expect(within(nav).getByRole('link', { name: /Books/ })).not.toHaveAttribute('aria-current');
    });

    it('a path that merely shares a prefix is not active', () => {
        navigationMock.pathname = '/w/ada/bookshelf';
        mount(WORKSPACE);
        expect(within(sidebarNav()).getByRole('link', { name: /Books/ })).not.toHaveAttribute('aria-current');
    });

    it('the sidebar search anchor opens the command palette', () => {
        mount(null);
        expect(document.querySelector('[data-command-palette]')).toBeNull();
        fireEvent.click(screen.getAllByTestId('sidebar-search-anchor')[0]);
        expect(document.querySelector('[data-command-palette]')).not.toBeNull();
    });
});

describe('AppShell — signed out (no workspace)', () => {
    it('names nobody and says so', () => {
        mount(null);
        expect(screen.getAllByTestId('sidebar-signed-out')[0].textContent).toBe('Not signed in');
        expect(screen.queryByTestId('top-chrome-user-menu')).toBeNull();
        expect(screen.queryByTestId('top-chrome-workspace-pill')).toBeNull();
    });

    it('keeps the theme toggle reachable in the top chrome', () => {
        mount(null);
        expect(document.getElementById('top-chrome-theme-toggle')).not.toBeNull();
    });

    it('offers no sign-out, even with a handler, when nobody is signed in', () => {
        mount(null, jest.fn());
        expect(screen.queryByTestId('nav-logout')).toBeNull();
    });
});

describe('AppShell — inside a workspace', () => {
    it('names the person, the workspace and the role', () => {
        mount(WORKSPACE);
        const identity = screen.getAllByTestId('sidebar-identity')[0];
        expect(identity.textContent).toContain('Ada Quill');
        expect(identity.textContent).toContain("Ada's books");
        expect(identity.textContent).toContain('Editor');
        expect(screen.queryByTestId('sidebar-signed-out')).toBeNull();
    });

    it('shows the workspace pill and the user menu in the top chrome', () => {
        mount(WORKSPACE);
        expect(screen.getByTestId('top-chrome-workspace-pill').textContent).toContain("Ada's books");
        expect(screen.getByTestId('top-chrome-workspace-pill')).toHaveAttribute('href', '/w/ada/settings');
        expect(screen.getByTestId('top-chrome-user-menu')).toHaveAttribute('aria-label', 'Account menu for Ada Quill');
    });

    it('falls back to "Account" for a person with no name', () => {
        mount({ ...WORKSPACE, userName: null });
        expect(screen.getAllByTestId('sidebar-identity')[0].textContent).toContain('Account');
    });

    it('renders sign-out only when a handler is supplied, and calls it', () => {
        const { unmount } = mount(WORKSPACE);
        expect(screen.queryByTestId('nav-logout')).toBeNull();
        unmount();

        const onLogout = jest.fn();
        mount(WORKSPACE, onLogout);
        fireEvent.click(screen.getAllByTestId('nav-logout')[0]);
        expect(onLogout).toHaveBeenCalledTimes(1);
    });
});
