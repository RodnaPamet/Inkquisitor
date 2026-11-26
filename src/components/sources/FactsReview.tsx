'use client';

/**
 * Reviewing source facts (Phase 4.0, D23 and D26): a book's facts page, or the
 * series library's.
 *
 *   each fact    its statement, quoted with the passage it rests on (the quote
 *                marked), its headings, its provenance (the source; Book or
 *                Series), and — on a book's page — the field it answers once
 *                confirmed; Confirm and Reject one by one
 *   flagged      a fact that reads as an instruction to the product (D14) is
 *                said to, and is confirmed only one by one
 *   bulk         "Confirm the N shown" and, per chapter, "Confirm this
 *                chapter's": only facts this page SHOWED, sent with the view's
 *                token, which the server checks (never an unseen fact)
 *   override     on a book's page, an inherited (series) confirmed fact may be
 *                replaced by the book's own answer, for this book only
 *
 * `canEdit` is `bible.edit`; a reader reads. Every text renders as text.
 */
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, CheckCheck, X } from 'lucide-react';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { APP_ROUTES } from '@/lib/app-routes';
import { BibleApiError } from '@/lib/bible/api-client';
import { sourcesApi, type FactProposalsPage, type FactsPage, type FactView, type LibraryRef } from '@/lib/sources/api-client';
import { FactProposalsPanel } from './FactProposalsPanel';

export interface FactsReviewProps {
    workspaceSlug: string;
    book: { id: string; title: string } | null;
    initial: FactsPage;
    canEdit: boolean;
    /** A book's page (Phase 4.1, D27): the pending proposals to invalidate a fact, decided here. */
    proposals?: FactProposalsPage;
}

const STATUS_FILTERS = ['PENDING', 'CONFIRMED', 'REJECTED', 'ALL'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

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

function OverrideEditor({ fact, onSave, onClear }: { fact: FactView; onSave: (text: string) => Promise<void>; onClear: () => Promise<void> }) {
    const t = useTranslations('sources.facts');
    const [open, setOpen] = useState(false);
    const [text, setText] = useState(fact.override?.text ?? '');
    if (!open) {
        return (
            <Button type="button" variant="secondary" onClick={() => setOpen(true)} data-testid="fact-override-open">
                {fact.override ? t('editOverride') : t('override')}
            </Button>
        );
    }
    return (
        <div className="w-full space-y-tight">
            <label htmlFor={`override-${fact.id}`} className="text-sm font-medium text-content-emphasis">
                {t('overrideLabel')}
            </label>
            <Textarea id={`override-${fact.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} />
            <div className="flex flex-wrap gap-tight">
                <Button type="button" variant="primary" onClick={() => onSave(text).then(() => setOpen(false))} disabled={text.trim() === ''}>
                    {t('saveOverride')}
                </Button>
                {fact.override ? (
                    <Button type="button" variant="secondary" onClick={() => onClear().then(() => setOpen(false))}>
                        {t('clearOverride')}
                    </Button>
                ) : null}
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                    {t('cancel')}
                </Button>
            </div>
        </div>
    );
}

function FactCard({ fact, canEdit, inherited, onDecide, onOverride }: { fact: FactView; canEdit: boolean; inherited: boolean; onDecide: (f: FactView, d: 'CONFIRM' | 'REJECT') => void; onOverride?: { save: (f: FactView, text: string) => Promise<void>; clear: (f: FactView) => Promise<void> } }) {
    const t = useTranslations('sources.facts');
    const flagged = fact.flags.includes('POSSIBLE_INSTRUCTION');
    return (
        <Card className="space-y-tight p-4" data-testid="fact-card" aria-labelledby={`fact-${fact.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-tight">
                <p id={`fact-${fact.id}`} className="text-sm font-semibold text-content-emphasis">
                    {fact.statement}
                </p>
                <StatusBadge variant={fact.status === 'CONFIRMED' ? 'success' : fact.status === 'REJECTED' ? 'neutral' : 'info'}>{t(`status.${fact.status}`)}</StatusBadge>
            </div>
            <p className="text-xs text-content-muted">
                {t('about', { subject: fact.subjectName, predicate: t.has(`predicate.${fact.predicate}`) ? t(`predicate.${fact.predicate}`) : fact.predicate })}
                {fact.storyTimeFrom ? ` · ${t('when', { from: fact.storyTimeFrom, to: fact.storyTimeTo ?? '' })}` : ''}
            </p>
            <blockquote className="border-l-2 border-border-subtle pl-3 text-sm text-content-default" data-testid="fact-passage">
                {fact.passage.before}
                <mark className="bg-bg-info text-content-emphasis">{fact.passage.quote}</mark>
                {fact.passage.after}
            </blockquote>
            <p className="text-xs text-content-muted">
                {t('provenance', { file: fact.provenance.filename, scope: fact.provenance.scope === 'SERIES' ? t('scopeSeries') : t('scopeBook') })}
                {fact.headingPath.length > 0 ? ` · ${fact.headingPath.join(' › ')}` : ''}
            </p>
            {fact.answers ? <p className="text-xs text-content-muted">{t('answers', { element: fact.answers.elementName, field: fact.answers.fieldKey })}</p> : null}
            {flagged ? <p className="text-sm text-content-warning">{t('flagged')}</p> : null}
            {fact.override ? (
                <p className="text-sm text-content-default" data-testid="fact-override">
                    {t('overridden', { text: fact.override.text })}
                </p>
            ) : null}
            {canEdit ? (
                <div className="flex flex-wrap gap-tight">
                    {fact.status !== 'CONFIRMED' ? (
                        <Button type="button" variant="primary" icon={<Check className="size-4" />} onClick={() => onDecide(fact, 'CONFIRM')} data-testid="fact-confirm">
                            {t('confirm')}
                        </Button>
                    ) : null}
                    {fact.status !== 'REJECTED' ? (
                        <Button type="button" variant="secondary" icon={<X className="size-4" />} onClick={() => onDecide(fact, 'REJECT')} data-testid="fact-reject">
                            {t('reject')}
                        </Button>
                    ) : null}
                    {inherited && fact.status === 'CONFIRMED' && onOverride ? <OverrideEditor fact={fact} onSave={(text) => onOverride.save(fact, text)} onClear={() => onOverride.clear(fact)} /> : null}
                </div>
            ) : null}
        </Card>
    );
}

export function FactsReview({ workspaceSlug, book, initial, canEdit, proposals }: FactsReviewProps) {
    const t = useTranslations('sources.facts');
    const errorText = useErrorText();
    const ref: LibraryRef = { slug: workspaceSlug, bookId: book?.id ?? null };
    const [page, setPage] = useState(initial);
    const [filter, setFilter] = useState<StatusFilter>('PENDING');
    const [busy, setBusy] = useState(false);

    const load = useCallback(
        async (status: StatusFilter, after?: string) => {
            setBusy(true);
            try {
                setPage(await sourcesApi.facts(ref, { status, after }));
            } catch (err) {
                toast.error(errorText(err));
            } finally {
                setBusy(false);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [workspaceSlug, book?.id, errorText],
    );

    const decide = async (fact: FactView, decision: 'CONFIRM' | 'REJECT') => {
        try {
            await sourcesApi.decide(workspaceSlug, fact.id, decision);
            toast.success(decision === 'CONFIRM' ? t('confirmed') : t('rejected'));
            await load(filter);
        } catch (err) {
            toast.error(errorText(err));
        }
    };

    const offered = useMemo(() => new Set(page.offered.ids), [page.offered]);
    const bulk = async (ids: string[]) => {
        if (ids.length === 0) return;
        try {
            const r = await sourcesApi.bulkConfirm(workspaceSlug, {
                view: book ? { kind: 'book', bookId: book.id } : { kind: 'series' },
                offeredIds: page.offered.ids,
                issuedAt: page.offered.issuedAt,
                token: page.offered.token,
                factIds: ids,
            });
            toast.success(t('bulkDone', { confirmed: r.confirmed, skipped: r.skipped }));
            await load(filter);
        } catch (err) {
            toast.error(errorText(err));
        }
    };

    const groups = useMemo(() => {
        const out = new Map<string, FactView[]>();
        for (const f of page.facts) {
            const key = `${f.provenance.filename}${f.headingPath.length > 0 ? ` › ${f.headingPath.join(' › ')}` : ''}`;
            out.set(key, [...(out.get(key) ?? []), f]);
        }
        return [...out.entries()];
    }, [page.facts]);

    const override = book
        ? {
              save: async (f: FactView, text: string) => {
                  try {
                      await sourcesApi.setOverride(workspaceSlug, book.id, f.id, text);
                      await load(filter);
                  } catch (err) {
                      toast.error(errorText(err));
                  }
              },
              clear: async (f: FactView) => {
                  try {
                      await sourcesApi.clearOverride(workspaceSlug, book.id, f.id);
                      await load(filter);
                  } catch (err) {
                      toast.error(errorText(err));
                  }
              },
          }
        : undefined;

    const sourcesHref = book ? APP_ROUTES.bookSources(workspaceSlug, book.id) : APP_ROUTES.series(workspaceSlug);
    const title = book ? t('title') : t('seriesTitle');
    const total = page.counts.PENDING + page.counts.CONFIRMED + page.counts.REJECTED;
    return (
        <EntityDetailLayout
            id="facts-page"
            breadcrumbs={book ? [{ label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) }, { label: title }] : [{ label: t('seriesCrumb'), href: APP_ROUTES.series(workspaceSlug) }, { label: title }]}
            title={title}
            meta={<span className="text-sm text-content-muted">{t('counts', { pending: page.counts.PENDING, confirmed: page.counts.CONFIRMED, rejected: page.counts.REJECTED })}</span>}
            actions={
                <Link href={sourcesHref} className={buttonVariants({ variant: 'secondary' })} id="facts-sources-link">
                    {t('sourcesLink')}
                </Link>
            }
        >
            <div className="space-y-section">
                {book && proposals ? <FactProposalsPanel workspaceSlug={workspaceSlug} bookId={book.id} initial={proposals} canEdit={canEdit} /> : null}
                <p className="text-sm text-content-muted">{t('help')}</p>
                <div className="flex flex-wrap items-center justify-between gap-tight">
                    <ToggleGroup
                        ariaLabel={t('filterLabel')}
                        options={STATUS_FILTERS.map((s) => ({ value: s, label: t(`filter.${s}`) }))}
                        selected={filter}
                        selectAction={(v: string) => {
                            setFilter(v as StatusFilter);
                            void load(v as StatusFilter);
                        }}
                    />
                    {canEdit && page.offered.ids.length > 0 ? (
                        <Button type="button" variant="primary" icon={<CheckCheck className="size-4" />} disabled={busy} onClick={() => bulk(page.offered.ids)} data-testid="facts-confirm-shown">
                            {t('confirmShown', { count: page.offered.ids.length })}
                        </Button>
                    ) : null}
                </div>
                {total === 0 ? (
                    <EmptyState title={t('notAssessed')} description={t('notAssessedHelp')} />
                ) : page.facts.length === 0 ? (
                    <p className="text-sm text-content-muted">{t('noneHere')}</p>
                ) : (
                    groups.map(([heading, facts]) => {
                        const groupIds = facts.filter((f) => offered.has(f.id)).map((f) => f.id);
                        return (
                            <section key={heading} className="space-y-default" aria-label={heading}>
                                <div className="flex flex-wrap items-center justify-between gap-tight">
                                    <h2 className="text-sm font-semibold text-content-emphasis">{heading}</h2>
                                    {canEdit && groupIds.length > 1 ? (
                                        <Button type="button" variant="secondary" onClick={() => bulk(groupIds)} data-testid="facts-confirm-group">
                                            {t('confirmGroup', { count: groupIds.length })}
                                        </Button>
                                    ) : null}
                                </div>
                                {facts.map((f) => (
                                    <FactCard key={f.id} fact={f} canEdit={canEdit} inherited={Boolean(book) && f.provenance.scope === 'SERIES'} onDecide={decide} onOverride={override} />
                                ))}
                            </section>
                        );
                    })
                )}
                {page.nextCursor ? (
                    <Button type="button" variant="secondary" onClick={() => load(filter, page.nextCursor ?? undefined)} disabled={busy}>
                        {t('more')}
                    </Button>
                ) : null}
            </div>
        </EntityDetailLayout>
    );
}
