/**
 * The Command Palette's navigation and action commands.
 *
 * Adapted from inflect-compliance's palette-commands suite (Epic 57; see
 * docs/carve-manifest.md). Verifies the two curated buckets:
 *
 *   - Navigation (Go to Books / Settings) — one row per sidebar destination,
 *     each with its route; selecting one calls `router.push()` and closes
 *     the palette. One workspace per author (D4), so the routes carry no
 *     slug and the rows render with or without a workspace.
 *   - Actions — only the universally safe ones (Toggle theme today). Sign-out
 *     returns with authentication (0.3).
 *   - Typing filters on label, English name and keywords; keywords match but
 *     never render.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import React from 'react';
import { render, renderHook, fireEvent, act, waitFor } from '@testing-library/react';

const navigationMock = {
    pathname: '/books',
    push: jest.fn(),
};
const toggleThemeMock = jest.fn();

jest.mock('next/navigation', () => ({
    usePathname: () => navigationMock.pathname,
    useRouter: () => ({
        push: (href: string) => navigationMock.push(href),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

// Stub `useTheme` so we don't need the real ThemeProvider tree just
// to exercise the action handler.
jest.mock('@/components/theme/ThemeProvider', () => ({
    useTheme: () => ({
        theme: 'dark',
        setTheme: jest.fn(),
        toggle: () => toggleThemeMock(),
    }),
    ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { CommandPalette, CommandPaletteProvider, useCommandPalette } from '@/components/command-palette';
import {
    filterPaletteCommands,
    usePaletteCommands,
    type PaletteCommand,
} from '@/components/command-palette/use-palette-commands';
import { APP_ROUTES } from '@/components/layout/SidebarNav';

// Render an auto-opened palette for each test.
function Shell({ children }: { children?: React.ReactNode }) {
    // Test-only inner component: opens the palette imperatively
    // after the provider mounts. Defined inline so it can call
    // useCommandPalette() under the just-mounted provider.

    function OpenOnMount() {
        const { open } = useCommandPalette();
        React.useEffect(() => {
            open();
        }, [open]);
        return null;
    }
    return (
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                {/* eslint-disable-next-line react-hooks/static-components */}
                <OpenOnMount />
                {children}
                <CommandPalette />
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
    );
}

beforeEach(() => {
    navigationMock.pathname = '/books';
    navigationMock.push.mockReset();
    toggleThemeMock.mockReset();
});

const row = (id: string) => document.querySelector(`[data-testid="command-palette-nav-${id}"], [data-testid="command-palette-action-${id}"]`);

describe('Command Palette — navigation commands', () => {
    it('renders exactly one row per sidebar destination', () => {
        render(<Shell />);
        const ids = Array.from(document.querySelectorAll('[data-testid^="command-palette-nav-nav:"]')).map((r) =>
            r.getAttribute('data-testid'),
        );
        expect(ids).toEqual(['command-palette-nav-nav:books', 'command-palette-nav-nav:settings']);
    });

    it('each navigation row points at the route the sidebar uses', () => {
        render(<Shell />);
        expect(row('nav:books')?.getAttribute('data-href')).toBe(APP_ROUTES.books);
        expect(row('nav:settings')?.getAttribute('data-href')).toBe(APP_ROUTES.settings);
    });

    it('selecting a navigation command calls router.push and closes the palette', async () => {
        const { queryByTestId } = render(<Shell />);
        fireEvent.click(row('nav:books')!);
        expect(navigationMock.push).toHaveBeenCalledWith('/books');
        await waitFor(() => {
            expect(queryByTestId('command-palette-input')).toBeNull();
        });
    });

    it('renders on any route — the commands need no workspace slug', () => {
        navigationMock.pathname = '/';
        render(<Shell />);
        expect(row('nav:books')).not.toBeNull();
    });

    it('filters commands by label when the user types', async () => {
        render(<Shell />);
        const input = document.querySelector('[data-testid="command-palette-input"]') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'sett' } });
        await waitFor(() => {
            expect(row('nav:settings')).not.toBeNull();
        });
        expect(row('nav:books')).toBeNull();
    });
});

describe('Command Palette — action commands', () => {
    it('renders exactly the safe, universal actions', () => {
        render(<Shell />);
        const ids = Array.from(document.querySelectorAll('[data-testid^="command-palette-action-action:"]')).map((a) =>
            a.getAttribute('data-testid'),
        );
        expect(ids).toEqual(['command-palette-action-action:toggle-theme']);
    });

    it('selecting "Toggle theme" invokes the theme hook and closes the palette', async () => {
        const { queryByTestId } = render(<Shell />);
        fireEvent.click(row('action:toggle-theme')!);
        await waitFor(() => {
            expect(queryByTestId('command-palette-input')).toBeNull();
        });
        // handleAction defers invocation by a microtask — flush.
        await act(async () => {
            await Promise.resolve();
        });
        expect(toggleThemeMock).toHaveBeenCalledTimes(1);
    });
});

describe('Command Palette — vocabulary', () => {
    function paletteCommands(): PaletteCommand[] {
        const { result } = renderHook(() => usePaletteCommands());
        return result.current;
    }
    const idsMatching = (query: string) => filterPaletteCommands(paletteCommands(), query).map((c) => c.id);

    it('an empty query returns every command', () => {
        expect(idsMatching('')).toEqual(['nav:books', 'nav:settings', 'action:toggle-theme']);
    });

    it('a keyword finds the row whose label does not carry it', () => {
        expect(idsMatching('manuscript')).toEqual(['nav:books']);
        expect(idsMatching('dark')).toEqual(['action:toggle-theme']);
    });

    it('a query matching nothing returns nothing', () => {
        // The negative control: a predicate mutated to `() => true` passes
        // every assertion above and fails this one.
        expect(idsMatching('zzzznotathing')).toEqual([]);
    });

    it('keywords match but never render — the row still reads by destination', async () => {
        render(<Shell />);
        const input = document.querySelector('[data-testid="command-palette-input"]') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'manuscript' } });
        await waitFor(() => {
            expect(row('nav:books')?.textContent).toContain('Go to Books');
        });
        expect(row('nav:books')?.textContent).not.toContain('manuscript');
    });
});

describe('Shortcut hints — filter trigger', () => {
    // Lightweight structural check that future UI refactors don't
    // accidentally strip the visible `F` hint off the filter trigger
    // or the aria-keyshortcuts affordance that screen readers pick up.
    const ROOT = path.resolve(__dirname, '../..');

    let src = '';
    beforeAll(() => {
        src = fs.readFileSync(
            path.join(ROOT, 'src/components/ui/filter/filter-select.tsx'),
            'utf-8',
        );
    });

    it('exposes aria-keyshortcuts="F" on the trigger for assistive tech', () => {
        expect(src).toMatch(/aria-keyshortcuts=["']F["']/);
    });

    it('renders a visible <kbd> chip reading "F" on the trigger', () => {
        expect(src).toMatch(
            /<kbd[\s\S]*?data-filter-shortcut-hint[\s\S]*?>\s*F\s*<\/kbd>/,
        );
    });

    it('the trigger carries the data-filter-trigger marker for E2E / visual tests', () => {
        expect(src).toContain('data-filter-trigger');
    });
});
