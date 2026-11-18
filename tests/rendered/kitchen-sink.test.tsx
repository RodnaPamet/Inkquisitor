/**
 * `/dev/kitchen-sink` mounts every lifted primitive.
 *
 * One assertion per primitive, each on something only that primitive
 * renders (its role, its data marker, its text) inside its own section —
 * not merely that the section exists, which a stray heading would satisfy.
 * `PROBES` is keyed exhaustively on `KitchenSinkPrimitive`, so a primitive
 * added to the page without a probe here is a compile error, and the first
 * case fails if the page and the list disagree.
 *
 * Each primitive also has a behavioural suite of its own in this directory
 * (ported from inflect-compliance where inflect had one, written new where it
 * did not); this suite is what proves the page renders them all. A probe that
 * could pass on the sink's own scaffolding (a trigger button the sink wrote)
 * drives the primitive and asserts what only it produces.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { Toaster } from 'sonner';

jest.mock('next/navigation', () => ({
    usePathname: () => '/dev/kitchen-sink',
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({}),
    useSearchParams: () => new URLSearchParams(),
}));

// jsdom measures every element as 0x0, which ParentSize reads as "draw
// nothing"; give the chart a real box (as tests/rendered/time-series-chart does).
jest.mock('@visx/responsive', () => {
    const actual = jest.requireActual('@visx/responsive');
    return {
        ...actual,
        ParentSize: ({ children }: { children: (args: { width: number; height: number }) => React.ReactNode }) => (
            <div style={{ width: 640, height: 192 }}>{children({ width: 640, height: 192 })}</div>
        ),
    };
});

import { KitchenSink, KITCHEN_SINK_PRIMITIVES, type KitchenSinkPrimitive } from '@/components/dev/KitchenSink';
import { CommandPalette, CommandPaletteProvider } from '@/components/command-palette';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { ThemeProvider } from '@/components/theme/ThemeProvider';

function mount() {
    return render(
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                <ThemeProvider>
                    <KitchenSink />
                    <CommandPalette />
                    <Toaster />
                </ThemeProvider>
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>,
    );
}

function section(name: KitchenSinkPrimitive): HTMLElement {
    const el = document.querySelector<HTMLElement>(`section[data-primitive="${name}"]`);
    if (!el) throw new Error(`kitchen sink has no section for ${name}`);
    return el;
}

const PROBES: Record<KitchenSinkPrimitive, (s: HTMLElement) => void | Promise<void>> = {
    button: (s) => expect(within(s).getByRole('button', { name: 'Primary' })).toBeInTheDocument(),
    card: (s) => expect(within(s).getByText('A card holds one discrete thing.')).toBeInTheDocument(),
    typography: (s) => expect(within(s).getByRole('heading', { level: 3, name: 'A heading' })).toBeInTheDocument(),
    'status-badge': (s) => expect(within(s).getByText('Blocked')).toBeInTheDocument(),
    'initials-avatar': (s) => expect(s.textContent).toContain('AQ'),
    breadcrumbs: (s) => expect(within(s).getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument(),
    'empty-state': (s) => expect(within(s).getByText('No books yet')).toBeInTheDocument(),
    'error-state': (s) => expect(within(s).getByText('Could not load')).toBeInTheDocument(),
    skeleton: (s) => expect(s.querySelector('[aria-hidden="true"], .animate-pulse, [data-skeleton]')).not.toBeNull(),
    'progressive-blur': (s) => expect(s.querySelector('[data-progressive-blur="bottom"]')).not.toBeNull(),
    'scroll-container': (s) => {
        const scroller = within(s).getByText('Scene 1').parentElement!;
        expect(scroller).toHaveClass('overflow-y-scroll');
        expect(within(scroller).getAllByText(/^Scene \d+$/)).toHaveLength(12);
    },
    'animated-size-container': (s) => {
        expect(within(s).queryByText(/The full synopsis grows the box/)).toBeNull();
        fireEvent.click(within(s).getByRole('button', { name: 'Show more' }));
        const grown = within(s).getByText(/The full synopsis grows the box/);
        expect(grown.closest('.overflow-hidden')).not.toBeNull();
    },
    tooltip: async (s) => {
        // The content exists only once the Tooltip opens it on focus.
        expect(screen.queryByText('A hint on hover or focus')).toBeNull();
        const trigger = within(s).getByRole('button', { name: 'Hover me' });
        act(() => trigger.focus());
        const tip = await screen.findByRole('tooltip');
        expect(tip).toHaveTextContent('A hint on hover or focus');
    },
    popover: (s) => {
        fireEvent.click(within(s).getByRole('button', { name: 'Open popover' }));
        expect(screen.getByText('A small floating panel.')).toBeInTheDocument();
    },
    modal: (s) => {
        fireEvent.click(within(s).getByRole('button', { name: 'Open modal' }));
        expect(screen.getByRole('dialog')).toHaveTextContent('Quick create, edit and confirm flows.');
    },
    sheet: (s) => {
        fireEvent.click(within(s).getByRole('button', { name: 'Open sheet' }));
        expect(screen.getByRole('dialog')).toHaveTextContent('Inspect and edit without losing the list.');
    },
    combobox: (s) => expect(within(s).getByRole('combobox')).toHaveTextContent('Choose a genre'),
    'form-field': (s) => {
        expect(within(s).getByLabelText(/Working title/)).toBeInTheDocument();
        expect(within(s).getByText('A logline is one sentence.')).toBeInTheDocument();
    },
    'field-group': (s) => {
        const group = within(s).getByRole('group', { name: 'Book details' });
        expect(within(group).getByLabelText('Series')).toBeInTheDocument();
    },
    checkbox: (s) => expect(within(s).getByRole('checkbox', { name: 'Series' })).toBeChecked(),
    'radio-group': (s) => expect(within(s).getByRole('radio', { name: 'Draft' })).toBeChecked(),
    'toggle-group': (s) => expect(within(s).getByRole('radio', { name: 'First' })).toHaveAttribute('aria-checked', 'true'),
    accordion: (s) => {
        const trigger = within(s).getByRole('button', { name: 'Setting' });
        fireEvent.click(trigger);
        expect(within(s).getByText('A lighthouse on a northern coast.')).toBeInTheDocument();
    },
    'date-picker': (s) => expect(s.querySelector('[data-date-picker-trigger]')).not.toBeNull(),
    'date-range-picker': (s) => expect(s.querySelector('[data-date-picker-trigger]')).not.toBeNull(),
    'data-table': (s) => {
        const table = within(s).getByRole('table');
        expect(within(table).getByText('The Lantern Keeper')).toBeInTheDocument();
        expect(within(table).getAllByRole('row')).toHaveLength(4); // header + three books
    },
    'filter-toolbar': (s) => expect(s.querySelector('[data-filter-trigger]')).not.toBeNull(),
    'checklist-gear-button': async (s) => {
        await userEvent.setup().click(within(s).getByRole('button', { name: 'Toggle columns' }));
        expect(await screen.findByTestId('checklist-toggle-words')).toHaveTextContent('Word count');
    },
    'virtualized-list': (s) => {
        // 500 items, a 160px window of 32px rows: windowed, not 500 nodes.
        const rows = within(s).getAllByText(/^Chapter \d+$/);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(50);
    },
    'time-series-chart': (s) => {
        const svg = s.querySelector('svg[data-chart="time-series"]');
        expect(svg).not.toBeNull();
        expect(svg!.getAttribute('data-chart-type')).toBe('area');
    },
    'undo-toast': async (s) => {
        // The toast exists only once the undo hook schedules it.
        expect(screen.queryByText('Note removed')).toBeNull();
        fireEvent.click(within(s).getByRole('button', { name: 'Remove a note' }));
        const toast = (await screen.findByText('Note removed')).closest<HTMLElement>('[data-undo-toast]')!;
        expect(toast).not.toBeNull();
        expect(within(toast).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    },
    'rich-text-editor': (s) => expect(within(s).getByRole('button', { name: 'Bold' })).toBeInTheDocument(),
    'version-diff': (s) => expect(within(s).getByLabelText('Compare from version')).toBeInTheDocument(),
    'entity-prev-next-nav': (s) => {
        expect(within(s).getByRole('button', { name: 'Previous book' })).toBeInTheDocument();
        expect(within(s).getByRole('button', { name: 'Next book' })).toBeInTheDocument();
    },
    'page-header': (s) => expect(within(s).getByRole('heading', { level: 1, name: 'The Lantern Keeper' })).toBeInTheDocument(),
    'page-actions': (s) => {
        const cluster = within(s).getByTestId('ks-page-actions');
        expect(within(cluster).getAllByRole('button').map((b) => b.textContent)).toEqual(['Export', 'Book']);
    },
    'page-breadcrumbs': (s) =>
        expect(within(within(s).getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Books' })).toHaveAttribute(
            'href',
            '/books',
        ),
    'list-page-shell': (s) => {
        expect(s.querySelector('[data-list-page-shell="true"]')).not.toBeNull();
        expect(within(s).getByRole('table')).toBeInTheDocument();
    },
    'entity-list-page': (s) => {
        expect(within(s).getByRole('heading', { level: 1, name: 'Books' })).toBeInTheDocument();
        expect(s.querySelector('[data-list-page-shell="true"]')).not.toBeNull();
        expect(s.querySelector('[data-filter-trigger]')).not.toBeNull();
        expect(within(s.querySelector<HTMLElement>('#ks-entity-table')!).getByText('Salt and Iron')).toBeInTheDocument();
    },
    'entity-detail-layout': (s) => {
        expect(within(s).getByRole('heading', { level: 1, name: 'Salt and Iron' })).toBeInTheDocument();
        expect(within(s).getByText('Overview body.')).toBeInTheDocument();
    },
    'dashboard-layout': (s) => expect(within(s).getByText('A dashboard composes cards.')).toBeInTheDocument(),
    'workspace-shell': (s) => {
        expect(s.querySelector('[data-workspace-shell="true"] [data-workspace-toolbar="true"]')).not.toBeNull();
        expect(s.querySelector('[data-workspace-body="true"]')).toHaveTextContent('The canvas surface (Phase 3).');
    },
    'theme-toggle': (s) => {
        const toggle = s.querySelector<HTMLElement>('#ks-theme-toggle')!;
        const before = toggle.getAttribute('data-theme-current');
        const label = toggle.getAttribute('aria-label');
        fireEvent.click(toggle);
        expect(toggle.getAttribute('data-theme-current')).not.toBe(before);
        expect(toggle.getAttribute('aria-label')).not.toBe(label);
        expect(document.documentElement.getAttribute('data-theme')).toBe(toggle.getAttribute('data-theme-current'));
    },
    'command-palette': (s) => {
        fireEvent.click(within(s).getByRole('button', { name: 'Open palette' }));
        expect(document.querySelector('[data-command-palette]')).not.toBeNull();
    },
};

describe('/dev/kitchen-sink', () => {
    it('renders one section per listed primitive, in order, and nothing unlisted', () => {
        mount();
        const rendered = Array.from(document.querySelectorAll('section[data-primitive]')).map((s) =>
            s.getAttribute('data-primitive'),
        );
        expect(rendered).toEqual([...KITCHEN_SINK_PRIMITIVES]);
    });

    it.each(KITCHEN_SINK_PRIMITIVES.map((p) => [p]))('mounts %s', async (name) => {
        mount();
        await PROBES[name](section(name));
    });
});
