'use client';

/**
 * A book's home (Phase 1.2): a board with one card per element kind, in the
 * fixed kind order, each listing the book's entries of that kind and how
 * complete they are — fields filled out of the fields the kind's template
 * has (`completeness`, which holds rule 6: a kind with no entries reads "Not
 * started", a template with no fields "Not assessed", never a percentage of
 * nothing).
 *
 * Creating an element opens `<CreateElementModal>`, from the header (no kind
 * chosen) or from a kind's card (that kind). Shown only when the server says
 * the viewer may edit (`canEdit`).
 *
 * Export (Phase 1.3) is two buttons, the Markdown bundle and the PDF, for
 * every viewer (`bible.view`); each downloads through `bibleDownload`, so a
 * refusal is a toast rather than a saved error (Phase 1.H, #27). Import opens
 * `<ImportModal>` and, like create, is offered only when the viewer may edit.
 *
 * A book of any size (Phase 1.H, #18): each card's count and completeness are
 * the server's aggregates over EVERY entry of the kind, and the card lists
 * the first page of entries by name with "Show more" fetching the next
 * (`listElements` with `kind` and `after`). Deleting the book opens
 * `<DeleteBookModal>` (export first, then a typed confirmation), for the
 * workspace's OWNER only (`canDeleteBook`, `books.delete`).
 *
 * Word search (Phase 3.4): `<BookSearch>` above the kinds, for every viewer.
 *
 * Interviews (Phase 2.4): "Grill me" on the whole book (the header) and on a
 * kind's card (every entry of that kind; a kind with no entry has nothing to
 * ask about and offers none) open the interview setup sheet, for editors
 * only; "Interviews" lists the book's interviews for every viewer.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { BookOpenCheck, FileDown, FileText, Flame, Library, MessagesSquare, Plus, Search, Trash2, Upload, Waypoints, GitCompareArrows, Crosshair } from 'lucide-react';
import { InterviewLauncher } from '@/components/interview/InterviewLauncher';
import { BookSearch } from '@/components/search/BookSearch';
import { buttonVariants } from '@/components/ui/button-variants';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, bibleFetch, type BoardKindView, type BookView, type ElementListItemView, type ElementPageView } from '@/lib/bible/api-client';
import { completeness, type Completeness } from '@/lib/bible/completeness';
import { STORY_MAP_KINDS, mapKindSlug } from '@/lib/canvas/map-kinds';
import type { BibleKind } from '@/lib/bible/kinds';
import type { KindSummary } from '@/lib/bible/ui-model';
import { CompletenessMeter } from './CompletenessMeter';
import { CreateElementModal } from './CreateElementModal';
import { DeleteBookModal } from './DeleteBookModal';
import { ImportModal } from './ImportModal';
import { useExportDownload } from './use-export-download';

export interface BookBoardProps {
    workspaceSlug: string;
    book: BookView;
    kinds: KindSummary[];
    /** Per kind: the aggregate counts and the first page of entries (`getBookBoard`). */
    board: BoardKindView[];
    canEdit: boolean;
    /** The viewer may delete the book (`books.delete`: the workspace's OWNER). */
    canDeleteBook?: boolean;
}

export function BookBoard({ workspaceSlug, book, kinds, board, canEdit, canDeleteBook = false }: BookBoardProps) {
    const t = useTranslations('bible.board');
    const tStage = useTranslations('bible.stage');
    const tTransfer = useTranslations('bible.transfer');
    const tDelete = useTranslations('bible.deleteBook');
    const tInterview = useTranslations('interview.launch');
    const tSetup = useTranslations('interview.setup');
    const tResearch = useTranslations('research');
    const tSources = useTranslations('sources');
    const tContinuity = useTranslations('continuity');
    const tInterrogation = useTranslations('interrogation');
    const tCanvas = useTranslations('canvas.kinds');
    const [creating, setCreating] = useState<{ kind: BibleKind | null } | null>(null);
    const [importing, setImporting] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const download = useExportDownload(workspaceSlug, book.id);

    const byKind = new Map<BibleKind, BoardKindView>(board.map((k) => [k.kind, k]));

    return (
        <DashboardLayout
            data-testid="book-board"
            header={{
                breadcrumbs: [{ label: t('breadcrumbBooks'), href: APP_ROUTES.books(workspaceSlug) }, { label: book.title }],
                title: book.title,
                description: book.logline ?? undefined,
                meta: <StatusBadge variant="neutral">{tStage(book.stage)}</StatusBadge>,
                actions: (
                    <div className="flex flex-wrap items-center gap-tight">
                        <Link href={APP_ROUTES.interviews(workspaceSlug, book.id)} className={buttonVariants({ variant: 'secondary' })} id="book-interviews">
                            <MessagesSquare className="size-4" aria-hidden="true" />
                            {tInterview('interviews')}
                        </Link>
                        <Link href={APP_ROUTES.research(workspaceSlug, book.id)} className={buttonVariants({ variant: 'secondary' })} id="book-research">
                            <Search className="size-4" aria-hidden="true" />
                            {tResearch('title')}
                        </Link>
                        <Link href={APP_ROUTES.bookSources(workspaceSlug, book.id)} className={buttonVariants({ variant: 'secondary' })} id="book-sources">
                            <Library className="size-4" aria-hidden="true" />
                            {tSources('title')}
                        </Link>
                        <Link href={APP_ROUTES.bookFacts(workspaceSlug, book.id)} className={buttonVariants({ variant: 'secondary' })} id="book-facts">
                            <BookOpenCheck className="size-4" aria-hidden="true" />
                            {tSources('facts.title')}
                        </Link>
                        <Link href={APP_ROUTES.continuity(workspaceSlug, book.id)} className={buttonVariants({ variant: 'secondary' })} id="book-continuity">
                            <GitCompareArrows className="size-4" aria-hidden="true" />
                            {tContinuity('title')}
                        </Link>
                        <Link href={APP_ROUTES.interrogate(workspaceSlug, book.id)} className={buttonVariants({ variant: 'secondary' })} id="book-interrogate">
                            <Crosshair className="size-4" aria-hidden="true" />
                            {tInterrogation('title')}
                        </Link>
                        {STORY_MAP_KINDS.map((kind) => (
                            <Link
                                key={kind}
                                href={APP_ROUTES.storyMap(workspaceSlug, book.id, mapKindSlug(kind))}
                                className={buttonVariants({ variant: 'secondary' })}
                                id={`book-map-${mapKindSlug(kind)}`}
                            >
                                <Waypoints className="size-4" aria-hidden="true" />
                                {tCanvas(kind)}
                            </Link>
                        ))}
                        {canEdit ? (
                            <InterviewLauncher
                                workspaceSlug={workspaceSlug}
                                bookId={book.id}
                                target={{ scope: 'BOOK' }}
                                title={tSetup('titleBook')}
                                label={tInterview('grillBook')}
                                icon={<Flame className="size-4" aria-hidden="true" />}
                                id="grill-book"
                            />
                        ) : null}
                        <Button
                            variant="secondary"
                            icon={<FileDown className="size-4" aria-hidden="true" />}
                            loading={download.busy === 'bundle'}
                            onClick={() => void download.start('bundle')}
                            id="export-bundle"
                        >
                            {tTransfer('exportBundle')}
                        </Button>
                        <Button
                            variant="secondary"
                            icon={<FileText className="size-4" aria-hidden="true" />}
                            loading={download.busy === 'pdf'}
                            onClick={() => void download.start('pdf')}
                            id="export-pdf"
                        >
                            {tTransfer('exportPdf')}
                        </Button>
                        {canEdit ? (
                            <>
                                <Button variant="secondary" icon={<Upload className="size-4" aria-hidden="true" />} onClick={() => setImporting(true)} id="import-open">
                                    {tTransfer('import')}
                                </Button>
                                <Button variant="primary" icon={<Plus className="size-4" aria-hidden="true" />} onClick={() => setCreating({ kind: null })} id="create-element">
                                    {t('createElement')}
                                </Button>
                            </>
                        ) : null}
                        {canDeleteBook ? (
                            <Button variant="secondary" icon={<Trash2 className="size-4" aria-hidden="true" />} onClick={() => setDeleting(true)} id="delete-book-open">
                                {tDelete('open')}
                            </Button>
                        ) : null}
                    </div>
                ),
            }}
        >
            <Card className="p-5">
                <BookSearch workspaceSlug={workspaceSlug} bookId={book.id} kindLabels={Object.fromEntries(kinds.map((k) => [k.kind, k.label]))} />
            </Card>
            <div className="grid grid-cols-1 gap-default md:grid-cols-2 xl:grid-cols-3" role="list" aria-label={t('kindsAria')}>
                {kinds.map((k) => {
                    const entry = byKind.get(k.kind) ?? { kind: k.kind, entryCount: 0, filledFieldCount: 0, entries: [], nextCursor: null };
                    return (
                        <KindCard
                            key={k.kind}
                            summary={k}
                            board={entry}
                            workspaceSlug={workspaceSlug}
                            bookId={book.id}
                            onAdd={canEdit ? () => setCreating({ kind: k.kind }) : undefined}
                            canInterview={canEdit}
                        />
                    );
                })}
            </div>
            {canEdit ? (
                <CreateElementModal
                    open={creating !== null}
                    setOpen={(v) => {
                        const next = typeof v === 'function' ? v(creating !== null) : v;
                        if (!next) setCreating(null);
                    }}
                    workspaceSlug={workspaceSlug}
                    bookId={book.id}
                    kinds={kinds}
                    initialKind={creating?.kind ?? null}
                />
            ) : null}
            {canEdit ? <ImportModal open={importing} setOpen={setImporting} workspaceSlug={workspaceSlug} bookId={book.id} /> : null}
            {canDeleteBook ? <DeleteBookModal open={deleting} setOpen={setDeleting} workspaceSlug={workspaceSlug} book={{ id: book.id, title: book.title }} /> : null}
        </DashboardLayout>
    );
}

function KindCard({
    summary,
    board,
    workspaceSlug,
    bookId,
    onAdd,
    canInterview = false,
}: {
    summary: KindSummary;
    board: BoardKindView;
    workspaceSlug: string;
    bookId: string;
    onAdd?: () => void;
    /** The viewer may run an interview (`bible.edit`): "Grill me" on this kind. */
    canInterview?: boolean;
}) {
    const t = useTranslations('bible.board');
    const tInterview = useTranslations('interview.launch');
    const tSetup = useTranslations('interview.setup');
    // The first page came with the board; "Show more" appends the next. A new
    // board (after a create or an import re-renders the page) starts again.
    const signature = `${board.entryCount}:${board.filledFieldCount}:${board.nextCursor ?? ''}:${board.entries.map((e) => e.id).join(',')}`;
    const [more, setMore] = useState<{ from: string; entries: ElementListItemView[]; nextCursor: string | null }>({
        from: signature,
        entries: [],
        nextCursor: board.nextCursor,
    });
    const [loadingMore, setLoadingMore] = useState(false);
    if (more.from !== signature) setMore({ from: signature, entries: [], nextCursor: board.nextCursor });
    const entries = [...board.entries, ...more.entries];
    const entryCount = board.entryCount;

    async function showMore() {
        if (!more.nextCursor) return;
        setLoadingMore(true);
        try {
            const page = await bibleFetch<ElementPageView>(BIBLE_API.elements(workspaceSlug, bookId, { kind: summary.kind, after: more.nextCursor }));
            setMore((m) => ({ from: m.from, entries: [...m.entries, ...page.elements], nextCursor: page.nextCursor }));
        } catch {
            toast.error(t('moreFailed'));
        } finally {
            setLoadingMore(false);
        }
    }

    const kindCompleteness: Completeness = completeness({
        entries: entryCount,
        filled: board.filledFieldCount,
        fieldsPerEntry: summary.fieldCount,
    });
    const headingId = `kind-${summary.kind}-heading`;
    return (
        <Card role="listitem" aria-labelledby={headingId} className="flex flex-col gap-default p-5" data-kind={summary.kind}>
            <div className="flex items-start justify-between gap-tight">
                <div className="min-w-0 space-y-tight">
                    <h2 id={headingId} className="text-base font-semibold text-content-emphasis">
                        {summary.label}
                    </h2>
                    <p className="text-xs text-content-muted">
                        {entryCount === 0 ? t('noEntries') : entryCount === 1 ? t('entriesOne') : t('entries', { count: entryCount })}
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-tight">
                    {canInterview && board.entryCount > 0 ? (
                        <InterviewLauncher
                            workspaceSlug={workspaceSlug}
                            bookId={bookId}
                            target={{ scope: 'KIND', kind: summary.kind }}
                            title={tSetup('titleKind', { kind: summary.label })}
                            label={null}
                            icon={<Flame className="size-3.5" aria-hidden="true" />}
                            size="sm"
                            aria-label={tInterview('grillKind', { kind: summary.label })}
                            data-testid={`grill-${summary.kind}`}
                        />
                    ) : null}
                    {onAdd ? (
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<Plus className="size-3.5" aria-hidden="true" />}
                            aria-label={t('addOfKind', { kind: summary.label })}
                            onClick={onAdd}
                            data-testid={`add-${summary.kind}`}
                        />
                    ) : null}
                </div>
            </div>
            <CompletenessMeter value={kindCompleteness} label={t('completenessOf', { kind: summary.label })} />
            {entries.length > 0 ? (
                <ul className="divide-y divide-[var(--border-subtle)]" aria-label={t('entriesOf', { kind: summary.label })}>
                    {entries.map((e) => {
                        const own = completeness({ entries: 1, filled: e.filledFieldCount, fieldsPerEntry: summary.fieldCount });
                        return (
                            <li key={e.id} className="flex items-center justify-between gap-tight py-2">
                                <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, e.id)} className="min-w-0 truncate text-sm text-content-default hover:underline">
                                    {e.name}
                                    {e.customLabel ? <span className="ml-1 text-xs text-content-muted">({e.customLabel})</span> : null}
                                </Link>
                                <span className="shrink-0 text-xs text-content-muted">
                                    {own.state === 'measured' ? t('fieldsFraction', { filled: own.filled, total: own.total }) : t('notAssessed')}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
            {more.nextCursor ? (
                <div className="flex items-center justify-between gap-tight">
                    <span className="text-xs text-content-muted">{t('showing', { shown: entries.length, count: entryCount })}</span>
                    <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void showMore()} data-testid={`more-${summary.kind}`}>
                        {t('showMore')}
                    </Button>
                </div>
            ) : null}
        </Card>
    );
}
