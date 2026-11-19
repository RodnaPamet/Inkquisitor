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
 * Export (Phase 1.3) is two download links, the Markdown bundle and the PDF,
 * for every viewer (`bible.view`); Import opens `<ImportModal>` and, like
 * create, is offered only when the viewer may edit.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { FileDown, FileText, Plus, Upload } from 'lucide-react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, type BookView, type ElementListItemView } from '@/lib/bible/api-client';
import { completeness, type Completeness } from '@/lib/bible/completeness';
import type { BibleKind } from '@/lib/bible/kinds';
import type { KindSummary } from '@/lib/bible/ui-model';
import { CompletenessMeter } from './CompletenessMeter';
import { CreateElementModal } from './CreateElementModal';
import { ImportModal } from './ImportModal';

export interface BookBoardProps {
    workspaceSlug: string;
    book: BookView;
    kinds: KindSummary[];
    elements: ElementListItemView[];
    canEdit: boolean;
}

export function BookBoard({ workspaceSlug, book, kinds, elements, canEdit }: BookBoardProps) {
    const t = useTranslations('bible.board');
    const tStage = useTranslations('bible.stage');
    const tTransfer = useTranslations('bible.transfer');
    const [creating, setCreating] = useState<{ kind: BibleKind | null } | null>(null);
    const [importing, setImporting] = useState(false);

    const byKind = new Map<BibleKind, ElementListItemView[]>();
    for (const e of elements) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);

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
                        <a href={BIBLE_API.exportBundle(workspaceSlug, book.id)} download className={buttonVariants({ variant: 'secondary' })} id="export-bundle">
                            <FileDown className="size-4" aria-hidden="true" />
                            {tTransfer('exportBundle')}
                        </a>
                        <a href={BIBLE_API.exportPdf(workspaceSlug, book.id)} download className={buttonVariants({ variant: 'secondary' })} id="export-pdf">
                            <FileText className="size-4" aria-hidden="true" />
                            {tTransfer('exportPdf')}
                        </a>
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
                    </div>
                ),
            }}
        >
            <div className="grid grid-cols-1 gap-default md:grid-cols-2 xl:grid-cols-3" role="list" aria-label={t('kindsAria')}>
                {kinds.map((k) => {
                    const entries = byKind.get(k.kind) ?? [];
                    return (
                        <KindCard
                            key={k.kind}
                            summary={k}
                            entries={entries}
                            workspaceSlug={workspaceSlug}
                            bookId={book.id}
                            onAdd={canEdit ? () => setCreating({ kind: k.kind }) : undefined}
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
        </DashboardLayout>
    );
}

function KindCard({
    summary,
    entries,
    workspaceSlug,
    bookId,
    onAdd,
}: {
    summary: KindSummary;
    entries: ElementListItemView[];
    workspaceSlug: string;
    bookId: string;
    onAdd?: () => void;
}) {
    const t = useTranslations('bible.board');
    const kindCompleteness: Completeness = completeness({
        entries: entries.length,
        filled: entries.reduce((n, e) => n + e.filledFieldCount, 0),
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
                        {entries.length === 0 ? t('noEntries') : entries.length === 1 ? t('entriesOne') : t('entries', { count: entries.length })}
                    </p>
                </div>
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
            <CompletenessMeter value={kindCompleteness} label={t('completenessOf', { kind: summary.label })} />
            {entries.length > 0 ? (
                <ul className="divide-y divide-[var(--border-subtle)]">
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
        </Card>
    );
}
