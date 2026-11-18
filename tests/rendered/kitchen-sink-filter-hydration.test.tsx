/**
 * The kitchen sink's URL-synced filter toolbar hydrates without a mismatch.
 *
 * `useFilterContext` starts from `window.location.search` on the client but
 * cannot see the browser's URL on the server, where it starts from
 * `serverFilters` (or from nothing). The sink used to pass no
 * `serverFilters`, so after picking Stage → Drafting (the URL becomes
 * `?stage=Drafting`) a reload rendered no pill on the server and a pill on
 * the client: a hydration error on the page meant to show there are none.
 *
 * This suite holds the sink's half: the page's search params reach
 * `useFilterContext` as `serverFilters`, and the client's first render from
 * that URL shows the pill. The server half — `useFilterContext` building the
 * same state from `serverFilters` with no window — is held by
 * tests/unit/filter-context-server-filters.test.tsx, and the page's hand-off
 * of its search params by tests/unit/kitchen-sink-route.test.tsx.
 */
import { render, within } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/dev/kitchen-sink',
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({}),
    useSearchParams: () => new URLSearchParams(window.location.search),
}));

jest.mock('@visx/responsive', () => {
    const actual = jest.requireActual('@visx/responsive');
    return { ...actual, ParentSize: () => null };
});

jest.mock('@/components/ui/filter/filter-context', () => {
    const actual = jest.requireActual('@/components/ui/filter/filter-context');
    return { ...actual, useFilterContext: jest.fn(actual.useFilterContext) };
});

import { KitchenSink } from '@/components/dev/KitchenSink';
import { useFilterContext } from '@/components/ui/filter/filter-context';
import { CommandPaletteProvider } from '@/components/command-palette';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { ThemeProvider } from '@/components/theme/ThemeProvider';

function mount(initialFilters: Record<string, string>) {
    return render(
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                <ThemeProvider>
                    <KitchenSink initialFilters={initialFilters} />
                </ThemeProvider>
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>,
    );
}

afterEach(() => {
    window.history.replaceState(null, '', '/dev/kitchen-sink');
    jest.mocked(useFilterContext).mockClear();
});

describe('kitchen sink filter toolbar hydration', () => {
    it('hands the page search params to the URL-synced toolbar as serverFilters', () => {
        mount({ stage: 'Drafting', q: 'lantern' });
        const urlSynced = jest
            .mocked(useFilterContext)
            .mock.calls.filter(([, keys, options]) => keys.includes('stage') && options?.syncUrl !== false);
        expect(urlSynced.length).toBeGreaterThan(0);
        for (const [, , options] of urlSynced) {
            expect(options?.serverFilters).toEqual({ stage: 'Drafting', q: 'lantern' });
        }
    });

    it('the client first render from a filtered URL shows the pill the server state names', () => {
        window.history.replaceState(null, '', '/dev/kitchen-sink?stage=Drafting');
        mount({ stage: 'Drafting' });
        const section = document.querySelector<HTMLElement>('section[data-primitive="filter-toolbar"]')!;
        expect(within(section).getByText('Drafting')).toBeInTheDocument();
    });

    it('any other toolbar on the page keeps its state out of the URL', () => {
        mount({});
        const others = jest.mocked(useFilterContext).mock.calls.filter(([, keys]) => !keys.includes('stage'));
        expect(others.length).toBeGreaterThan(0);
        for (const [, , options] of others) expect(options?.syncUrl).toBe(false);
    });
});
