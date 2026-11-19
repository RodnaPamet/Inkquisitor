'use client';

/**
 * The kitchen sink: every primitive the UI platform lifted, rendered once on
 * one page, so a token or primitive change can be seen in both themes in one
 * place. Mounted at `/dev/kitchen-sink`, which answers 404 in production.
 *
 * Each primitive sits in a `<section data-primitive="<name>">`.
 * `KITCHEN_SINK_PRIMITIVES` is the list of them, and
 * `tests/rendered/kitchen-sink.test.tsx` mounts this component and checks
 * every listed section rendered its primitive — so a primitive added to the
 * platform is added here and there together.
 *
 * Fixture data is invented placeholder text: no author's work is ever shown
 * here (roadmap rule 4).
 *
 * Lifted modules with no section of their own, and why:
 *   - the hit-area, button-like-keys, control-variants, overlay-depth and
 *     checklist-order helpers, the filter and table internals (select,
 *     range panel, columns dropdown, pagination): they render only inside
 *     a primitive shown here;
 *   - AppShell, AppShellFrame, SidebarNav, TopChrome, MobileNavDrawer,
 *     IdentityPill, user-menu, nav-bar, nav-item and nav-section: the shell
 *     around this page IS their rendering, and tests/rendered/app-shell*
 *     and nav-* hold them;
 *   - the shortcut help overlay: press `?` on this page.
 */

import { useState, type ReactNode } from 'react';
import { BookOpen, Columns3, Feather, Library, PenLine, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Caption, Eyebrow, Heading } from '@/components/ui/typography';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { InfoTooltip, Tooltip } from '@/components/ui/tooltip';
import { Popover } from '@/components/ui/popover';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { FieldGroup } from '@/components/ui/field-group';
import { ScrollContainer } from '@/components/ui/scroll-container';
import { AnimatedSizeContainer } from '@/components/ui/animated-size-container';
import { ProgressiveBlur } from '@/components/ui/progressive-blur';
import { ChecklistGearButton } from '@/components/ui/checklist-gear-button';
import type { ChecklistGearItem } from '@/components/ui/checklist-order';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { DatePicker, DateRangePicker } from '@/components/ui/date-picker';
import { DataTable, createColumns } from '@/components/ui/table';
import { createFilterDefs, FilterProvider, useFilterContext } from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { useToastWithUndo } from '@/components/ui/hooks';
import { RichTextEditor, type RichTextContentType } from '@/components/ui/RichTextEditor';
import { VersionDiff } from '@/components/ui/VersionDiff';
import { EntityPrevNextNav } from '@/components/ui/entity-prev-next-nav';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageActions } from '@/components/layout/PageActions';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { WorkspaceShell } from '@/components/layout/WorkspaceShell';
import { Areas, TimeSeriesChart, XAxis, YAxis, type Data, type Series } from '@inkquisitor/ui/components/ui/charts';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { useCommandPalette } from '@/components/command-palette';

/** Every primitive the page renders, in page order. */
export const KITCHEN_SINK_PRIMITIVES = [
    'button',
    'card',
    'typography',
    'status-badge',
    'initials-avatar',
    'breadcrumbs',
    'empty-state',
    'error-state',
    'skeleton',
    'progressive-blur',
    'scroll-container',
    'animated-size-container',
    'tooltip',
    'popover',
    'modal',
    'sheet',
    'combobox',
    'form-field',
    'field-group',
    'checkbox',
    'radio-group',
    'toggle-group',
    'accordion',
    'date-picker',
    'date-range-picker',
    'data-table',
    'filter-toolbar',
    'checklist-gear-button',
    'virtualized-list',
    'time-series-chart',
    'undo-toast',
    'rich-text-editor',
    'version-diff',
    'entity-prev-next-nav',
    'page-header',
    'page-actions',
    'page-breadcrumbs',
    'list-page-shell',
    'entity-list-page',
    'entity-detail-layout',
    'dashboard-layout',
    'workspace-shell',
    'theme-toggle',
    'command-palette',
] as const;

export type KitchenSinkPrimitive = (typeof KITCHEN_SINK_PRIMITIVES)[number];

function Section({ name, title, children }: { name: KitchenSinkPrimitive; title: string; children: ReactNode }) {
    return (
        <section
            data-primitive={name}
            aria-labelledby={`ks-section-${name}`}
            className="space-y-default border-t border-border-subtle pt-section"
        >
            <Heading level={2} id={`ks-section-${name}`}>
                {title}
            </Heading>
            <div className="flex flex-wrap items-start gap-default">{children}</div>
        </section>
    );
}

// ─── Fixtures ──────────────────────────────────────────────────────────

interface SampleBook {
    id: string;
    title: string;
    stage: string;
}

const SAMPLE_BOOKS: SampleBook[] = [
    { id: 'b1', title: 'The Lantern Keeper', stage: 'Drafting' },
    { id: 'b2', title: 'Salt and Iron', stage: 'Concept' },
    { id: 'b3', title: 'A Quiet Inventory', stage: 'Revising' },
];

const BOOK_COLUMNS = createColumns<SampleBook>([
    { id: 'title', header: 'Title', cell: ({ row }) => row.original.title },
    { id: 'stage', header: 'Stage', cell: ({ row }) => row.original.stage },
]);

const GENRES: ComboboxOption[] = [
    { value: 'mystery', label: 'Mystery' },
    { value: 'fantasy', label: 'Fantasy' },
    { value: 'romance', label: 'Romance' },
    { value: 'literary', label: 'Literary fiction' },
];

const { filters: BOOK_FILTERS, filterKeys: BOOK_FILTER_KEYS } = createFilterDefs({
    stage: {
        label: 'Stage',
        icon: PenLine,
        options: [
            { value: 'Concept', label: 'Concept' },
            { value: 'Drafting', label: 'Drafting' },
            { value: 'Revising', label: 'Revising' },
        ],
    },
});

const { filters: GENRE_FILTERS, filterKeys: GENRE_FILTER_KEYS } = createFilterDefs({
    genre: {
        label: 'Genre',
        icon: Tag,
        options: GENRES.map((g) => ({ value: g.value, label: String(g.label) })),
    },
});

interface WordCount {
    words: number;
}

const WORD_COUNTS: Data<WordCount> = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    date: new Date(Date.UTC(2026, 10, 10 + day)),
    values: { words: [800, 1200, 650, 1500, 900, 1700, 1100][day] },
}));

const WORD_SERIES: Series<WordCount>[] = [{ id: 'words', valueAccessor: (d) => d.values.words, isActive: true }];

const VERSIONS = [
    { id: 'v1', versionNumber: 1, contentType: 'MARKDOWN', text: 'The keeper climbs the tower.\nThe lamp is cold.' },
    { id: 'v2', versionNumber: 2, contentType: 'MARKDOWN', text: 'The keeper climbs the tower at dusk.\nThe lamp is cold.' },
];

/**
 * The filter toolbar syncs its state to the URL. `initialFilters` is the
 * page's search params, handed to `useFilterContext` as `serverFilters`, so
 * the server render shows the same pills as the client's first render after
 * a reload of a filtered URL (no hydration mismatch).
 */
function FilterSection({ initialFilters }: { initialFilters: Record<string, string> }) {
    const ctx = useFilterContext(BOOK_FILTERS, BOOK_FILTER_KEYS, { serverFilters: initialFilters });
    return (
        <FilterProvider value={ctx}>
            <FilterToolbar filters={BOOK_FILTERS} searchId="ks-filter-search" searchPlaceholder="Search books…" />
        </FilterProvider>
    );
}

/** The EntityListPage section keeps its filter out of the URL: one toolbar on the page owns it. */
function EntityListSection() {
    const ctx = useFilterContext(GENRE_FILTERS, GENRE_FILTER_KEYS, { syncUrl: false, initialState: {} });
    return (
        <FilterProvider value={ctx}>
            <EntityListPage<SampleBook>
                header={{ title: 'Books', count: '3 books' }}
                filters={{ defs: GENRE_FILTERS, searchId: 'ks-entity-search', searchPlaceholder: 'Search books…' }}
                table={{ data: SAMPLE_BOOKS, columns: BOOK_COLUMNS, getRowId: (r) => r.id, 'data-testid': 'ks-entity-table' }}
            />
        </FilterProvider>
    );
}

const COLUMN_ITEMS_DEFAULT = ['title', 'stage', 'words'];

function ChecklistSection() {
    const [visible, setVisible] = useState<string[]>(COLUMN_ITEMS_DEFAULT);
    const labels: Record<string, string> = { title: 'Title', stage: 'Stage', words: 'Word count' };
    const items: ChecklistGearItem[] = [
        ...visible.map((id, i) => ({ id, label: labels[id], visible: true, order: i + 1 })),
        ...COLUMN_ITEMS_DEFAULT.filter((id) => !visible.includes(id)).map((id) => ({
            id,
            label: labels[id],
            visible: false,
            order: null,
        })),
    ];
    return (
        <ChecklistGearButton
            items={items}
            onToggle={(id) => setVisible((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]))}
            onReset={() => setVisible(COLUMN_ITEMS_DEFAULT)}
            someModified={visible.length !== COLUMN_ITEMS_DEFAULT.length}
            title="Toggle columns"
            icon={<Columns3 className="size-4" aria-hidden="true" />}
            data-testid="ks-checklist-gear"
        />
    );
}

function AnimatedSizeSection() {
    const [open, setOpen] = useState(false);
    return (
        <div className="w-80 space-y-tight">
            <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
                {open ? 'Show less' : 'Show more'}
            </Button>
            <AnimatedSizeContainer height className="rounded-lg border border-border-subtle">
                <p className="p-3 text-sm text-content-default">A keeper, a lamp, a storm.</p>
                {open && (
                    <p className="px-3 pb-3 text-sm text-content-muted">
                        The full synopsis grows the box, and the box animates to fit.
                    </p>
                )}
            </AnimatedSizeContainer>
        </div>
    );
}

// ─── The page ──────────────────────────────────────────────────────────

export interface KitchenSinkProps {
    /** The page's search params, flattened; seeds the URL-synced filter toolbar. */
    initialFilters?: Record<string, string>;
}

export function KitchenSink({ initialFilters = {} }: KitchenSinkProps) {
    const [modalOpen, setModalOpen] = useState(false);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [genre, setGenre] = useState<ComboboxOption | null>(null);
    const [draft, setDraft] = useState<{ value: string; type: RichTextContentType }>({
        value: '<p>An opening line.</p>',
        type: 'HTML',
    });
    const [pov, setPov] = useState<string | null>('first');
    const [tab, setTab] = useState<'overview' | 'notes'>('overview');
    const triggerUndo = useToastWithUndo();
    const { open: openPalette } = useCommandPalette();

    return (
        <div className="space-y-section pb-page" data-testid="kitchen-sink">
            <PageHeader
                title="Kitchen sink"
                description="Every lifted UI primitive, rendered once. Not shipped to production."
            />

            <Section name="button" title="Button">
                <Button variant="primary">Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="primary" disabled>
                    Disabled
                </Button>
            </Section>

            <Section name="card" title="Card">
                <Card className="max-w-sm">
                    <p className="text-sm text-content-default">A card holds one discrete thing.</p>
                </Card>
            </Section>

            <Section name="typography" title="Typography">
                <div>
                    <Eyebrow>Eyebrow</Eyebrow>
                    <Heading level={3}>A heading</Heading>
                    <Caption>A caption under it.</Caption>
                </div>
            </Section>

            <Section name="status-badge" title="Status badge">
                <StatusBadge variant="neutral">Concept</StatusBadge>
                <StatusBadge variant="info">Drafting</StatusBadge>
                <StatusBadge variant="success">Ready</StatusBadge>
                <StatusBadge variant="warning">Needs a pass</StatusBadge>
                <StatusBadge variant="error">Blocked</StatusBadge>
            </Section>

            <Section name="initials-avatar" title="Initials avatar">
                <InitialsAvatar value="Ada Quill" />
            </Section>

            <Section name="breadcrumbs" title="Breadcrumbs">
                <Breadcrumbs items={[{ label: 'Books', href: '/books' }, { label: 'The Lantern Keeper' }]} />
            </Section>

            <Section name="empty-state" title="Empty state">
                <EmptyState icon={Library} title="No books yet" description="Start one from a concept." />
            </Section>

            <Section name="error-state" title="Error state">
                <ErrorState title="Could not load" description="Try again in a moment." />
            </Section>

            <Section name="skeleton" title="Skeleton">
                <SkeletonCard className="w-64" />
            </Section>

            <Section name="progressive-blur" title="Progressive blur">
                <div className="relative h-32 w-64 overflow-hidden rounded-lg border border-border-subtle">
                    <p className="p-3 text-sm text-content-default">
                        Text that runs under the blurred edge fades out instead of stopping at a hard line.
                    </p>
                    <ProgressiveBlur side="bottom" size="3rem" />
                </div>
            </Section>

            <Section name="scroll-container" title="Scroll container">
                <div className="h-32 w-64 rounded-lg border border-border-subtle">
                    <ScrollContainer className="h-32">
                        {Array.from({ length: 12 }, (_, i) => (
                            <p key={i} className="px-3 py-1 text-sm text-content-default">
                                Scene {i + 1}
                            </p>
                        ))}
                    </ScrollContainer>
                </div>
            </Section>

            <Section name="animated-size-container" title="Animated size container">
                <AnimatedSizeSection />
            </Section>

            <Section name="tooltip" title="Tooltip">
                <Tooltip content="A hint on hover or focus">
                    <Button variant="secondary">Hover me</Button>
                </Tooltip>
                <InfoTooltip content="Help text sits behind an info icon." />
            </Section>

            <Section name="popover" title="Popover">
                <Popover
                    openPopover={popoverOpen}
                    setOpenPopover={setPopoverOpen}
                    content={<div className="p-3 text-sm text-content-default">A small floating panel.</div>}
                >
                    <Button variant="secondary">Open popover</Button>
                </Popover>
            </Section>

            <Section name="modal" title="Modal">
                <Button variant="secondary" onClick={() => setModalOpen(true)}>
                    Open modal
                </Button>
                <Modal showModal={modalOpen} setShowModal={setModalOpen} title="A modal">
                    <Modal.Header title="A modal" />
                    <Modal.Body>
                        <p className="text-sm text-content-default">Quick create, edit and confirm flows.</p>
                    </Modal.Body>
                </Modal>
            </Section>

            <Section name="sheet" title="Sheet">
                <Button variant="secondary" onClick={() => setSheetOpen(true)}>
                    Open sheet
                </Button>
                <Sheet open={sheetOpen} onOpenChange={setSheetOpen} size="md" title="A sheet">
                    <Sheet.Body>
                        <p className="text-sm text-content-default">Inspect and edit without losing the list.</p>
                    </Sheet.Body>
                </Sheet>
            </Section>

            <Section name="combobox" title="Combobox">
                <Combobox
                    options={GENRES}
                    selected={genre}
                    setSelected={setGenre}
                    placeholder="Choose a genre"
                    searchPlaceholder="Search genres…"
                />
            </Section>

            <Section name="form-field" title="Form field">
                <div className="w-72 space-y-default">
                    <FormField label="Working title" description="You can change it later." required>
                        <Input placeholder="Untitled" />
                    </FormField>
                    <FormField label="Logline" error="A logline is one sentence.">
                        <Textarea placeholder="A keeper, a lamp, a storm." />
                    </FormField>
                </div>
            </Section>

            <Section name="field-group" title="Field group">
                <div className="w-full max-w-xl">
                    <FieldGroup title="Book details" description="Grouped fields share a heading." columns={2}>
                        <FormField label="Series">
                            <Input placeholder="None" />
                        </FormField>
                        <FormField label="Target length">
                            <Input placeholder="90,000 words" />
                        </FormField>
                    </FieldGroup>
                </div>
            </Section>

            <Section name="checkbox" title="Checkbox">
                <div className="flex items-center gap-tight">
                    <Checkbox id="ks-checkbox" defaultChecked />
                    <Label htmlFor="ks-checkbox">Series</Label>
                </div>
            </Section>

            <Section name="radio-group" title="Radio group">
                <RadioGroup defaultValue="draft" aria-label="Stage">
                    <div className="flex items-center gap-tight">
                        <RadioGroupItem value="concept" id="ks-radio-concept" />
                        <Label htmlFor="ks-radio-concept">Concept</Label>
                    </div>
                    <div className="flex items-center gap-tight">
                        <RadioGroupItem value="draft" id="ks-radio-draft" />
                        <Label htmlFor="ks-radio-draft">Draft</Label>
                    </div>
                </RadioGroup>
            </Section>

            <Section name="toggle-group" title="Toggle group">
                <ToggleGroup
                    ariaLabel="Point of view"
                    options={[
                        { value: 'first', label: 'First' },
                        { value: 'third', label: 'Third' },
                    ]}
                    selected={pov}
                    selectAction={setPov}
                />
            </Section>

            <Section name="accordion" title="Accordion">
                <Accordion type="single" collapsible className="w-80">
                    <AccordionItem value="setting">
                        <AccordionTrigger>Setting</AccordionTrigger>
                        <AccordionContent>A lighthouse on a northern coast.</AccordionContent>
                    </AccordionItem>
                    <AccordionItem value="cast">
                        <AccordionTrigger>Cast</AccordionTrigger>
                        <AccordionContent>The keeper and the storm.</AccordionContent>
                    </AccordionItem>
                </Accordion>
            </Section>

            <Section name="date-picker" title="Date picker">
                <DatePicker placeholder="Pick a date" />
            </Section>

            <Section name="date-range-picker" title="Date range picker">
                <DateRangePicker placeholder="Pick a range" />
            </Section>

            <Section name="data-table" title="Data table">
                <div className="w-full max-w-2xl">
                    <DataTable data={SAMPLE_BOOKS} columns={BOOK_COLUMNS} getRowId={(r) => r.id} data-testid="ks-books-table" />
                </div>
            </Section>

            <Section name="filter-toolbar" title="Filter toolbar">
                <FilterSection initialFilters={initialFilters} />
            </Section>

            <Section name="checklist-gear-button" title="Checklist gear">
                <ChecklistSection />
            </Section>

            <Section name="virtualized-list" title="Virtualized list">
                <div className="w-64 rounded-lg border border-border-default">
                    <VirtualizedList
                        itemCount={500}
                        itemSize={32}
                        height={160}
                        renderItem={({ index, style }) => (
                            <div style={style} className="px-3 py-1.5 text-sm text-content-default">
                                Chapter {index + 1}
                            </div>
                        )}
                    />
                </div>
            </Section>

            <Section name="time-series-chart" title="Time-series chart">
                <div className="h-48 w-full max-w-2xl">
                    <TimeSeriesChart data={WORD_COUNTS} series={WORD_SERIES}>
                        <YAxis showGridLines />
                        <Areas />
                        <XAxis />
                    </TimeSeriesChart>
                </div>
            </Section>

            <Section name="undo-toast" title="Undo toast">
                <Button
                    variant="secondary"
                    onClick={() =>
                        triggerUndo({
                            action: async () => undefined,
                            message: 'Note removed',
                            undoMessage: 'Undo',
                        })
                    }
                >
                    Remove a note
                </Button>
            </Section>

            <Section name="rich-text-editor" title="Rich text editor">
                <div className="w-full max-w-2xl">
                    <RichTextEditor
                        value={draft.value}
                        contentType={draft.type}
                        onChange={(value, type) => setDraft({ value, type })}
                        onModeChange={(type, value) => setDraft({ value, type })}
                    />
                </div>
            </Section>

            <Section name="version-diff" title="Version diff">
                <div className="w-full max-w-2xl">
                    <VersionDiff versions={VERSIONS} />
                </div>
            </Section>

            <Section name="entity-prev-next-nav" title="Previous / next">
                <EntityPrevNextNav ids={['b1', 'b2', 'b3']} currentId="b2" hrefFor={(id) => `/books/${id}`} labelSingular="book" />
            </Section>

            <Section name="page-header" title="Page header">
                <PageHeader
                    eyebrow="Book"
                    title="The Lantern Keeper"
                    description="A one-sentence description."
                    actions={<Button variant="secondary">Action</Button>}
                />
            </Section>

            <Section name="page-actions" title="Page actions">
                <div className="w-full max-w-2xl">
                    <PageActions data-testid="ks-page-actions">
                        <Button variant="secondary">Export</Button>
                        <Button variant="primary">Book</Button>
                    </PageActions>
                </div>
            </Section>

            <Section name="page-breadcrumbs" title="Page breadcrumbs">
                <div>
                    <PageBreadcrumbs items={[{ label: 'Books', href: '/books' }, { label: 'Salt and Iron' }]} className="" />
                    <Caption>On a wide screen the trail moves to the top chrome.</Caption>
                </div>
            </Section>

            <Section name="list-page-shell" title="List page shell">
                <div className="h-72 w-full max-w-2xl overflow-hidden rounded-lg border border-border-subtle">
                    <ListPageShell>
                        <ListPageShell.Header>
                            <Heading level={3}>Books</Heading>
                        </ListPageShell.Header>
                        <ListPageShell.Body>
                            <DataTable fillBody data={SAMPLE_BOOKS} columns={BOOK_COLUMNS} getRowId={(r) => r.id} data-testid="ks-shell-table" />
                        </ListPageShell.Body>
                    </ListPageShell>
                </div>
            </Section>

            <Section name="entity-list-page" title="Entity list page">
                <div className="h-96 w-full max-w-2xl overflow-hidden rounded-lg border border-border-subtle p-3">
                    <EntityListSection />
                </div>
            </Section>

            <Section name="entity-detail-layout" title="Entity detail layout">
                <div className="w-full max-w-2xl">
                    <EntityDetailLayout
                        back={{ href: '/books', label: 'Books' }}
                        title="Salt and Iron"
                        tabs={[
                            { key: 'overview', label: 'Overview' },
                            { key: 'notes', label: 'Notes', count: 2 },
                        ]}
                        activeTab={tab}
                        onTabChange={setTab}
                    >
                        <p className="text-sm text-content-default">{tab === 'overview' ? 'Overview body.' : 'Notes body.'}</p>
                    </EntityDetailLayout>
                </div>
            </Section>

            <Section name="dashboard-layout" title="Dashboard layout">
                <div className="w-full max-w-2xl">
                    <DashboardLayout header={{ title: 'Readiness' }}>
                        <Card>
                            <p className="text-sm text-content-default">A dashboard composes cards.</p>
                        </Card>
                    </DashboardLayout>
                </div>
            </Section>

            <Section name="workspace-shell" title="Workspace shell">
                <div className="flex h-64 w-full max-w-2xl flex-col rounded-lg border border-border-subtle p-3">
                    <WorkspaceShell className="flex-1">
                        <WorkspaceShell.Header>
                            <Heading level={3}>Story canvas</Heading>
                        </WorkspaceShell.Header>
                        <WorkspaceShell.Toolbar>
                            <Button variant="secondary">Fit to screen</Button>
                        </WorkspaceShell.Toolbar>
                        <WorkspaceShell.Body className="rounded-lg bg-bg-muted">
                            <p className="p-3 text-sm text-content-muted">The canvas surface (Phase 3).</p>
                        </WorkspaceShell.Body>
                    </WorkspaceShell>
                </div>
            </Section>

            <Section name="theme-toggle" title="Theme toggle">
                <ThemeToggle id="ks-theme-toggle" />
            </Section>

            <Section name="command-palette" title="Command palette">
                <Button variant="secondary" icon={<Feather />} onClick={openPalette}>
                    Open palette
                </Button>
                <span className="inline-flex items-center gap-tight text-sm text-content-muted">
                    <BookOpen className="size-4" aria-hidden="true" /> or press ⌘K / Ctrl+K
                </span>
            </Section>
        </div>
    );
}
