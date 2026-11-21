'use client';

/**
 * A library's Sources page (Phase 4.0, D23 and D26): a book's, or the
 * workspace's series library.
 *
 *   upload      DOCX, Markdown, TXT, EPUB or PDF, at most 20 MB; read in the
 *               request, stored as encrypted passages, never as a file; a
 *               refusal worded from its reason (`sources.reasons`)
 *   a source    its format, size, passages, facts and status; its estimated
 *               cost and its "at most", shown BEFORE anything is sent; reading
 *               its facts starts only after the author confirms that amount;
 *               progress polled while it runs; a stop worded from its reason;
 *               resumable; removed through `useToastWithUndo`
 *   series      (a book's page) the series library's sources, each with a
 *               toggle: this book draws on it, or not (D26)
 *
 * What the viewer may do is `canEdit` (`bible.edit`), decided on the server; a
 * reader reads. Every name renders as text.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { BookOpenCheck, FileUp, Play, Trash2 } from 'lucide-react';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { StatusBadge } from '@/components/ui/status-badge';
import { useToastWithUndo } from '@/components/ui/hooks';
import { APP_ROUTES } from '@/lib/app-routes';
import { BibleApiError } from '@/lib/bible/api-client';
import { formatMicroUsd, sourcesApi, type LibraryRef, type SourceView } from '@/lib/sources/api-client';
import { isLiveStatus, SOURCE_UPLOAD_MAX_BYTES } from '@/lib/sources/vocabulary';

export interface SourcesPageProps {
    workspaceSlug: string;
    /** A book's library, or null for the series library. */
    book: { id: string; title: string } | null;
    sources: SourceView[];
    /** A book's page: the series sources, each with whether this book draws on it. */
    series?: Array<SourceView & { optedIn: boolean }>;
    canEdit: boolean;
}

const POLL_MS = 2_000;
const ACCEPT = '.docx,.md,.markdown,.txt,.epub,.pdf';

function useErrorText() {
    const t = useTranslations('sources.reasons');
    return useCallback(
        (err: unknown) => {
            const reason = err instanceof BibleApiError ? err.reason : null;
            return reason && t.has(reason) ? t(reason) : t('generic');
        },
        [t],
    );
}

function statusVariant(status: string): 'info' | 'success' | 'neutral' | 'warning' {
    if (isLiveStatus(status)) return 'info';
    if (status === 'DONE') return 'success';
    if (status === 'STOPPED' || status === 'FAILED') return 'warning';
    return 'neutral';
}

function SourceCard({ source, slug, canEdit, onChanged, onRemove }: { source: SourceView; slug: string; canEdit: boolean; onChanged: (s: SourceView) => void; onRemove: (s: SourceView) => void }) {
    const t = useTranslations('sources');
    const errorText = useErrorText();
    const [confirming, setConfirming] = useState(false);
    /** The server's own figure, when it answered that the cost changed since the page showed it. */
    const [quoted, setQuoted] = useState<{ worst: number; expected: number } | null>(null);
    const worst = quoted?.worst ?? worstForRemaining(source);
    const expected = quoted?.expected ?? source.estimateMicroUsd;
    const live = isLiveStatus(source.status);
    const remaining = source.chunkCount - source.chunksDone;
    const startable = canEdit && !live && remaining > 0;

    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => {
            sourcesApi
                .get(slug, source.id)
                .then((r) => onChanged(r.source))
                .catch(() => undefined);
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [live, slug, source.id, onChanged]);

    const start = async () => {
        try {
            await sourcesApi.ingest(slug, source.id, worst);
            setQuoted(null);
            onChanged({ ...source, status: 'QUEUED', outcome: null });
            toast.success(t('started'));
        } catch (err) {
            const details = err instanceof BibleApiError ? (err.details as { worstCaseMicroUsd?: number; expectedMicroUsd?: number } | undefined) : undefined;
            if (err instanceof BibleApiError && err.reason === 'ESTIMATE_CHANGED' && details?.worstCaseMicroUsd !== undefined) {
                // Show the new amount; the author confirms again.
                setQuoted({ worst: details.worstCaseMicroUsd, expected: details.expectedMicroUsd ?? expected });
            }
            toast.error(errorText(err));
            throw err;
        }
    };

    return (
        <Card className="space-y-tight p-4" data-testid="source-card" aria-labelledby={`source-${source.id}-name`}>
            <div className="flex flex-wrap items-center justify-between gap-tight">
                <h3 id={`source-${source.id}-name`} className="text-sm font-semibold text-content-emphasis">
                    {source.filename}
                    {source.version > 1 ? <span className="ml-2 text-xs font-normal text-content-muted">{t('version', { version: source.version })}</span> : null}
                </h3>
                <StatusBadge variant={statusVariant(source.status)}>{t(`status.${source.status}`)}</StatusBadge>
            </div>
            <p className="text-sm text-content-muted">
                {t('summary', { format: source.format, chunks: source.chunkCount, done: source.chunksDone, facts: source.factCount, kb: Math.max(1, Math.round(source.byteLength / 1024)) })}
            </p>
            {source.outcome && source.outcome !== 'OK' ? <p className="text-sm text-content-muted">{t.has(`outcome.${source.outcome}`) ? t(`outcome.${source.outcome}`) : t('outcome.generic')}</p> : null}
            {live ? (
                <p className="text-sm text-content-muted" role="status" aria-live="polite">
                    {t('progress', { done: source.chunksDone, total: source.chunkCount })}
                </p>
            ) : null}
            <p className="text-sm text-content-muted">
                {t('cost', { expected: formatMicroUsd(source.estimateMicroUsd), worst: formatMicroUsd(source.worstCaseMicroUsd), spent: formatMicroUsd(source.spentMicroUsd) })}
            </p>
            {canEdit ? (
                <div className="flex flex-wrap gap-tight">
                    {startable ? (
                        <Button type="button" variant="primary" icon={<Play className="size-4" />} onClick={() => setConfirming(true)} data-testid="source-read-facts">
                            {source.chunksDone > 0 ? t('resume') : t('readFacts')}
                        </Button>
                    ) : null}
                    <Button type="button" variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => onRemove(source)} data-testid="source-remove">
                        {t('remove')}
                    </Button>
                </div>
            ) : null}
            <Modal.Confirm
                showModal={confirming}
                setShowModal={setConfirming}
                title={t('confirmTitle', { name: source.filename })}
                description={t('confirmBody', { expected: formatMicroUsd(expected), worst: formatMicroUsd(worst), chunks: remaining })}
                tone="info"
                confirmLabel={t('confirmLabel', { worst: formatMicroUsd(worst) })}
                onConfirm={start}
            />
        </Card>
    );
}

/** The "at most" of the chunks still to read: the whole estimate before a first run, its share after (the server holds the exact figure). */
function worstForRemaining(source: SourceView): number {
    if (source.chunksDone === 0) return source.worstCaseMicroUsd;
    return Math.ceil((source.worstCaseMicroUsd * (source.chunkCount - source.chunksDone)) / source.chunkCount);
}

export function SourcesPage({ workspaceSlug, book, sources: initial, series: initialSeries, canEdit }: SourcesPageProps) {
    const t = useTranslations('sources');
    const errorText = useErrorText();
    const ref: LibraryRef = { slug: workspaceSlug, bookId: book?.id ?? null };
    const [sources, setSources] = useState(initial);
    const [series, setSeries] = useState(initialSeries ?? []);
    const [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const undo = useToastWithUndo();

    const replace = useCallback((s: SourceView) => setSources((list) => list.map((x) => (x.id === s.id ? s : x))), []);

    const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (file.size > SOURCE_UPLOAD_MAX_BYTES) {
            toast.error(t('reasons.BODY_TOO_LARGE'));
            return;
        }
        setBusy(true);
        try {
            const r = await sourcesApi.upload(ref, file);
            setSources((list) => [r.source, ...list]);
            toast.success(t('uploaded'));
        } catch (err) {
            toast.error(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const remove = (s: SourceView) => {
        setSources((list) => list.filter((x) => x.id !== s.id));
        undo({
            action: () => sourcesApi.remove(workspaceSlug, s.id),
            undoAction: () => setSources((list) => (list.some((x) => x.id === s.id) ? list : [s, ...list])),
            message: t('removed', { name: s.filename }),
            undoMessage: t('undo'),
            onError: (err) => {
                setSources((list) => [s, ...list]);
                toast.error(errorText(err));
            },
        });
    };

    const toggle = async (s: SourceView & { optedIn: boolean }) => {
        if (!book) return;
        try {
            const r = await sourcesApi.optIn(workspaceSlug, book.id, s.id, !s.optedIn);
            setSeries((list) => list.map((x) => (x.id === s.id ? { ...x, optedIn: r.optedIn } : x)));
        } catch (err) {
            toast.error(errorText(err));
        }
    };

    const title = book ? t('title') : t('seriesTitle');
    const factsHref = book ? APP_ROUTES.bookFacts(workspaceSlug, book.id) : APP_ROUTES.seriesFacts(workspaceSlug);
    return (
        <EntityDetailLayout
            id="sources-page"
            breadcrumbs={book ? [{ label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) }, { label: title }] : [{ label: t('booksCrumb'), href: APP_ROUTES.books(workspaceSlug) }, { label: title }]}
            title={title}
            meta={<span className="text-sm text-content-muted">{book ? t('description') : t('seriesDescription')}</span>}
            actions={
                <Link href={factsHref} className={buttonVariants({ variant: 'secondary' })} id="sources-facts-link">
                    <BookOpenCheck className="size-4" aria-hidden="true" />
                    {t('reviewFacts')}
                </Link>
            }
        >
            <div className="space-y-section">
                <p className="text-sm text-content-muted">{t('privacy')}</p>
                {canEdit ? (
                    <div className="flex flex-wrap items-center gap-tight">
                        <input ref={fileInput} type="file" accept={ACCEPT} className="sr-only" id="source-upload-input" onChange={onFile} aria-label={t('upload')} />
                        <Button type="button" variant="primary" icon={<FileUp className="size-4" />} disabled={busy} onClick={() => fileInput.current?.click()} id="source-upload">
                            {busy ? t('uploading') : t('upload')}
                        </Button>
                        <span className="text-sm text-content-muted">{t('uploadHelp')}</span>
                    </div>
                ) : (
                    <p className="text-sm text-content-muted">{t('readOnly')}</p>
                )}
                <section className="space-y-default" aria-labelledby="sources-list-heading">
                    <h2 id="sources-list-heading" className="text-base font-semibold text-content-emphasis">
                        {book ? t('bookList') : t('seriesList')}
                    </h2>
                    {sources.length === 0 ? (
                        <EmptyState title={t('empty')} description={t('emptyHelp')} />
                    ) : (
                        <div className="space-y-default">
                            {sources.map((s) => (
                                <SourceCard key={s.id} source={s} slug={workspaceSlug} canEdit={canEdit} onChanged={replace} onRemove={remove} />
                            ))}
                        </div>
                    )}
                </section>
                {book ? (
                    <section className="space-y-default" aria-labelledby="series-optin-heading" id="series-opt-in">
                        <h2 id="series-optin-heading" className="text-base font-semibold text-content-emphasis">
                            {t('seriesPanel')}
                        </h2>
                        <p className="text-sm text-content-muted">
                            {t('seriesPanelHelp')}{' '}
                            <Link href={APP_ROUTES.series(workspaceSlug)} className="underline">
                                {t('seriesLink')}
                            </Link>
                        </p>
                        {series.length === 0 ? (
                            <p className="text-sm text-content-muted">{t('seriesEmpty')}</p>
                        ) : (
                            <ul className="space-y-tight">
                                {series.map((s) => (
                                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-tight">
                                        <span className="text-sm text-content-default">
                                            {s.filename} <span className="text-content-muted">· {t('factsCount', { count: s.factCount })}</span>
                                        </span>
                                        {canEdit ? (
                                            <Button type="button" variant={s.optedIn ? 'secondary' : 'primary'} onClick={() => toggle(s)} aria-pressed={s.optedIn} data-testid="series-opt-in">
                                                {s.optedIn ? t('stopDrawing') : t('drawOn')}
                                            </Button>
                                        ) : (
                                            <span className="text-sm text-content-muted">{s.optedIn ? t('drawnOn') : t('notDrawnOn')}</span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                ) : null}
            </div>
        </EntityDetailLayout>
    );
}
