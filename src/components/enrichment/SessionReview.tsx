'use client';

/**
 * An interview's proposed bible changes, reviewed (Phase 2.5). Every change
 * waits for the author (rule 1):
 *
 *   a field change   a `<VersionDiff>` of the field's value now against the
 *                    proposed one, the answers it is drawn from, and Accept,
 *                    Edit then accept (the bible's own `<FieldEditor>` for the
 *                    field's type) and Reject. An entry that changed since the
 *                    proposal was made says so, and the diff is against its
 *                    value NOW; accepting then tells the server the author saw
 *                    it (`reviewedCurrent`).
 *   a flag           a proposal whose text addresses the product itself is
 *                    marked "possible instruction" with what that means (owner
 *                    decision D14); it is accepted one by one, never in bulk
 *   bulk accept      only for unflagged ADDs into fields still empty (the
 *                    server checks again, and refuses the whole batch otherwise)
 *   a new entry      shown apart: its kind, name and summary, the answers that
 *                    name it; Accept creates it, Edit changes the name and
 *                    summary first, Reject drops it
 *   a relation's     (Phase 3.3) a change to one of a relation's fields is a
 *     field          field change, named "A — label — B"
 *   a new relation   (Phase 3.3) its ends, note and fields, the answers it is
 *                    drawn from; one that joins a new entry waits until that
 *                    entry is accepted (`StructuralProposals`)
 *   the rounds       each round's reconcile run, in plain words; a failed or
 *                    refused one can be run again
 *
 * What the viewer may do is `canEdit` (`bible.edit`), decided on the server; a
 * reader sees every proposal and its sources as text, with no control. A
 * refusal is worded from its `details.reason` (`enrichment.errors`), never the
 * server's sentence. Values render as text: rich text through the diff's own
 * tag strip, never as HTML.
 */
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Pencil, RotateCcw, X } from 'lucide-react';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { VersionDiff } from '@/components/ui/VersionDiff';
import { FieldEditor } from '@/components/bible/FieldEditor';
import { APP_ROUTES } from '@/lib/app-routes';
import { BibleApiError } from '@/lib/bible/api-client';
import type { FieldValue } from '@/lib/bible/field-values';
import type { BibleKind } from '@/lib/bible/kinds';
import { escapeHtml } from '@/lib/bible/snapshot-text';
import type { FieldDef } from '@/lib/bible/template-schema';
import {
    enrichmentApi,
    type CitedAnswerView,
    type FieldProposalView,
    type NewElementProposalView,
    type NewRelationProposalView,
    type RelationFieldProposalView,
    type ReviewIds,
    type SessionReviewView,
} from '@/lib/enrichment/api-client';
import { NewRelationCard, ProposalFlags, ProposalSources, ProposedFields, proposalStatusVariant } from './StructuralProposals';

export interface SessionReviewProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    review: SessionReviewView;
    canEdit: boolean;
    kindLabels: Record<BibleKind, string>;
    /** What the interview asked about, worded (the breadcrumb). */
    interviewTitle: string;
}

/** A field value as the lines `<VersionDiff>` compares: escaped HTML, one paragraph per line (an empty field is no line). */
export function valueAsDiffHtml(def: FieldDef, value: FieldValue | null, scaleOf: (n: number) => string): string {
    if (value === null) return '';
    if (Array.isArray(value)) return value.map((v) => `<p>${escapeHtml(v)}</p>`).join('');
    if (typeof value === 'number') return `<p>${escapeHtml(scaleOf(value))}</p>`;
    if (def.type === 'richtext') return value;
    if (def.type === 'choice') return `<p>${escapeHtml(def.options.find((o) => o.value === value)?.label ?? value)}</p>`;
    return `<p>${escapeHtml(value)}</p>`;
}

function useErrorText() {
    const t = useTranslations('enrichment.errors');
    return useCallback(
        (err: unknown) => {
            const reason = err instanceof BibleApiError ? err.reason : null;
            return reason && t.has(reason) ? t(reason) : t('generic');
        },
        [t],
    );
}

type ChangeProposal = FieldProposalView | RelationFieldProposalView;

interface CardActions {
    busy: boolean;
    accept: (p: ChangeProposal, value?: FieldValue | null) => Promise<boolean>;
    reject: (id: string) => Promise<void>;
}

/**
 * A change to one field: an element's (FIELD) or, since Phase 3.3, a
 * relation's (RELATION_FIELD), named "A — label — B" and linked to the
 * declaring end's page, where the relation is read.
 */
function FieldProposalCard({ p, answers, canEdit, actions, scaleOf, workspaceSlug, bookId }: { p: ChangeProposal; answers: Record<string, CitedAnswerView>; canEdit: boolean; actions: CardActions; scaleOf: (n: number) => string; workspaceSlug: string; bookId: string }) {
    const t = useTranslations('enrichment');
    const subject =
        p.kind === 'RELATION_FIELD'
            ? { href: APP_ROUTES.bibleElement(workspaceSlug, bookId, p.relation.from.id), name: t('relationAria', { from: p.relation.from.name, label: p.relation.label, to: p.relation.to.name }), testId: 'relation-field-proposal' }
            : { href: APP_ROUTES.bibleElement(workspaceSlug, bookId, p.elementId), name: p.elementName, testId: 'field-proposal' };
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<FieldValue | null>(p.proposedValue);
    const pending = p.status === 'PENDING';
    const changed = p.baseVersion !== p.currentVersion;
    const headingId = `proposal-${p.id}-title`;
    const versions = [
        { id: 'current', versionNumber: Math.max(p.currentVersion, 1), contentType: 'HTML', text: valueAsDiffHtml(p.field, p.currentValue, scaleOf) },
        { id: 'proposed', versionNumber: Math.max(p.currentVersion, 1) + 1, contentType: 'HTML', text: valueAsDiffHtml(p.field, p.proposedValue, scaleOf) },
    ];
    return (
        <Card className="space-y-default p-5" id={`proposal-${p.id}`} data-testid={subject.testId} data-status={p.status} data-op={p.operation} aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-tight">
                <div className="min-w-0 space-y-1">
                    <h3 id={headingId} className="text-base font-semibold text-content-emphasis">
                        {p.field.label}
                    </h3>
                    <p className="text-sm text-content-muted">
                        <Link href={subject.href} className="hover:underline">
                            {subject.name}
                        </Link>
                        {p.roundNumber !== null ? ` · ${t('roundLabel', { number: p.roundNumber })}` : null}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-tight">
                    <StatusBadge variant={p.operation === 'REMOVE' ? 'warning' : 'info'}>{t(`op.${p.operation}`)}</StatusBadge>
                    <StatusBadge variant={proposalStatusVariant(p.status)} data-testid="proposal-status">
                        {t(`status.${p.status}`)}
                    </StatusBadge>
                </div>
            </div>
            {pending ? <ProposalFlags id={p.id} flags={p.flags} /> : null}
            {pending && changed ? (
                <p className="rounded-md border border-border-default bg-bg-subtle p-3 text-sm text-content-default" data-testid="proposal-changed">
                    {t('changedSince', { base: p.baseVersion, current: p.currentVersion })}
                </p>
            ) : null}
            {p.operation === 'REMOVE' ? <p className="text-sm text-content-default">{t('removeExplained')}</p> : null}
            {pending ? (
                <VersionDiff versions={versions} fromVersionId="current" toVersionId="proposed" data-testid={`proposal-diff-${p.id}`} />
            ) : null}
            {editing ? (
                <div className="space-y-default rounded-md border border-border-subtle p-3">
                    <p className="text-sm font-medium text-content-emphasis">{t('editing')}</p>
                    <FieldEditor def={p.field} value={draft} onChange={setDraft} readOnly={false} />
                </div>
            ) : null}
            <ProposalSources ids={p.citedAnswerIds} answers={answers} />
            {canEdit && pending ? (
                <div className="flex flex-wrap items-center gap-tight">
                    {editing ? (
                        <>
                            <Button
                                variant="primary"
                                icon={<Check className="size-4" aria-hidden="true" />}
                                loading={actions.busy}
                                onClick={async () => {
                                    if (await actions.accept(p, draft)) setEditing(false);
                                }}
                                id={`accept-edit-${p.id}`}
                            >
                                {t('saveAccept')}
                            </Button>
                            <Button variant="secondary" onClick={() => setEditing(false)} id={`cancel-edit-${p.id}`}>
                                {t('cancelEdit')}
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button
                                variant="primary"
                                icon={<Check className="size-4" aria-hidden="true" />}
                                loading={actions.busy}
                                onClick={() => void actions.accept(p)}
                                aria-label={t('acceptAria', { field: p.field.label, element: subject.name })}
                                id={`accept-${p.id}`}
                            >
                                {t('accept')}
                            </Button>
                            {p.operation !== 'REMOVE' ? (
                                <Button
                                    variant="secondary"
                                    icon={<Pencil className="size-4" aria-hidden="true" />}
                                    onClick={() => {
                                        setDraft(p.proposedValue);
                                        setEditing(true);
                                    }}
                                    id={`edit-${p.id}`}
                                >
                                    {t('edit')}
                                </Button>
                            ) : null}
                            <Button
                                variant="secondary"
                                icon={<X className="size-4" aria-hidden="true" />}
                                disabled={actions.busy}
                                onClick={() => void actions.reject(p.id)}
                                aria-label={t('rejectAria', { field: p.field.label, element: subject.name })}
                                id={`reject-${p.id}`}
                            >
                                {t('reject')}
                            </Button>
                        </>
                    )}
                </div>
            ) : null}
        </Card>
    );
}

function NewElementCard({
    p,
    answers,
    canEdit,
    busy,
    kindLabel,
    onAccept,
    onReject,
    workspaceSlug,
    bookId,
}: {
    p: NewElementProposalView;
    answers: Record<string, CitedAnswerView>;
    canEdit: boolean;
    busy: boolean;
    kindLabel: string;
    onAccept: (p: NewElementProposalView, edit?: { name: string; summary: string | null }) => Promise<boolean>;
    onReject: (id: string) => Promise<void>;
    workspaceSlug: string;
    bookId: string;
}) {
    const t = useTranslations('enrichment');
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(p.name);
    const [summary, setSummary] = useState(p.summary ?? '');
    const pending = p.status === 'PENDING';
    const headingId = `proposal-${p.id}-title`;
    return (
        <Card className="space-y-default p-5" id={`proposal-${p.id}`} data-testid="new-element-proposal" data-status={p.status} aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-tight">
                <div className="min-w-0 space-y-1">
                    <h3 id={headingId} className="text-base font-semibold text-content-emphasis">
                        {p.name}
                    </h3>
                    <p className="text-sm text-content-muted">{t('kindLabel', { kind: kindLabel })}</p>
                </div>
                <StatusBadge variant={proposalStatusVariant(p.status)} data-testid="proposal-status">
                    {t(`status.${p.status}`)}
                </StatusBadge>
            </div>
            {pending ? <ProposalFlags id={p.id} flags={p.flags} /> : null}
            {p.summary && !editing ? <p className="whitespace-pre-wrap text-sm text-content-default">{p.summary}</p> : null}
            {p.slot && pending ? (
                <p className="text-sm text-content-muted" data-testid="slot-placement">
                    {t('slotPlacement', { a: p.slot.afterName, b: p.slot.beforeName })}
                </p>
            ) : null}
            <ProposedFields fields={p.fields} title={t('firstFields')} />
            {p.createdElementId ? (
                <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, p.createdElementId)} className="text-sm text-content-emphasis hover:underline">
                    {t('openElement')}
                </Link>
            ) : null}
            {editing ? (
                <div className="space-y-default rounded-md border border-border-subtle p-3">
                    <FormField label={t('nameLabel')} required>
                        <Input value={name} onChange={(e) => setName(e.target.value)} id={`new-name-${p.id}`} />
                    </FormField>
                    <FormField label={t('summaryLabel')}>
                        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} id={`new-summary-${p.id}`} />
                    </FormField>
                </div>
            ) : null}
            <ProposalSources ids={p.citedAnswerIds} answers={answers} />
            {canEdit && pending ? (
                <div className="flex flex-wrap items-center gap-tight">
                    {editing ? (
                        <>
                            <Button
                                variant="primary"
                                icon={<Check className="size-4" aria-hidden="true" />}
                                loading={busy}
                                disabled={name.trim() === ''}
                                onClick={async () => {
                                    if (await onAccept(p, { name, summary: summary.trim() === '' ? null : summary })) setEditing(false);
                                }}
                                id={`accept-edit-${p.id}`}
                            >
                                {t('saveAccept')}
                            </Button>
                            <Button variant="secondary" onClick={() => setEditing(false)} id={`cancel-edit-${p.id}`}>
                                {t('cancelEdit')}
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button variant="primary" icon={<Check className="size-4" aria-hidden="true" />} loading={busy} onClick={() => void onAccept(p)} id={`accept-${p.id}`}>
                                {t('accept')}
                            </Button>
                            <Button variant="secondary" icon={<Pencil className="size-4" aria-hidden="true" />} onClick={() => setEditing(true)} id={`edit-${p.id}`}>
                                {t('edit')}
                            </Button>
                            <Button variant="secondary" icon={<X className="size-4" aria-hidden="true" />} disabled={busy} onClick={() => void onReject(p.id)} id={`reject-${p.id}`}>
                                {t('reject')}
                            </Button>
                        </>
                    )}
                </div>
            ) : null}
        </Card>
    );
}

export function SessionReview({ workspaceSlug, book, review: initial, canEdit, kindLabels, interviewTitle }: SessionReviewProps) {
    const t = useTranslations('enrichment');
    const tFields = useTranslations('bible.fields');
    const errorText = useErrorText();
    const [review, setReview] = useState(initial);
    const [busy, setBusy] = useState(false);
    const ids: ReviewIds = useMemo(() => ({ slug: workspaceSlug, bookId: book.id, sessionId: review.session.id }), [workspaceSlug, book.id, review.session.id]);
    const scaleOf = useCallback((n: number) => tFields('scaleOf', { value: String(n), max: 5 }), [tFields]);

    const reload = useCallback(async () => {
        try {
            setReview((await enrichmentApi.review(ids)).review);
        } catch {
            // The page keeps what it has; the next action reads again.
        }
    }, [ids]);

    const run = useCallback(
        async (action: () => Promise<string | null>): Promise<boolean> => {
            setBusy(true);
            try {
                const message = await action();
                if (message) toast.success(message);
                await reload();
                return true;
            } catch (err) {
                toast.error(errorText(err));
                const reason = err instanceof BibleApiError ? err.reason : null;
                if (reason === 'VERSION_CONFLICT' || reason === 'PROPOSAL_OUTDATED' || reason === 'PROPOSAL_STALE' || reason === 'PROPOSAL_DECIDED' || reason === 'BULK_INELIGIBLE' || reason === 'RELATION_EXISTS' || reason === 'END_NOT_CREATED' || reason === 'END_GONE') await reload();
                return false;
            } finally {
                setBusy(false);
            }
        },
        [reload, errorText],
    );

    const acceptField = (p: ChangeProposal, value?: FieldValue | null) =>
        run(async () => {
            await enrichmentApi.accept(ids, p.id, {
                baseVersion: p.currentVersion,
                reviewedCurrent: p.baseVersion !== p.currentVersion ? true : undefined,
                ...(value !== undefined ? { value } : {}),
            });
            return t('accepted');
        });
    const acceptNew = (p: NewElementProposalView, edit?: { name: string; summary: string | null }) =>
        run(async () => {
            const name = edit?.name ?? p.name;
            await enrichmentApi.accept(ids, p.id, edit ? { name: edit.name, summary: edit.summary } : {});
            return t('acceptedNew', { name });
        });
    const acceptRelation = (p: NewRelationProposalView) =>
        run(async () => {
            await enrichmentApi.accept(ids, p.id, {});
            return t('acceptedRelation');
        });
    const reject = async (id: string) => {
        await run(async () => {
            await enrichmentApi.reject(ids, id);
            return t('rejected');
        });
    };
    // The server says what is eligible; a flagged proposal (D14) is never sent in bulk whatever it says.
    const eligible = review.fields.filter((f) => f.bulkEligible && f.flags.length === 0);
    const bulk = () =>
        run(async () => {
            const { decisions } = await enrichmentApi.bulkAccept(
                ids,
                eligible.map((f) => ({ proposalId: f.id, baseVersion: f.currentVersion })),
            );
            return t('bulkAccepted', { count: decisions.length });
        });
    const retry = (roundNumber: number) =>
        run(async () => {
            await enrichmentApi.reconcile(ids, roundNumber);
            return t('runRetried', { number: roundNumber });
        });

    const total = review.fields.length + review.newElements.length + review.relationFields.length + review.newRelations.length;
    const nothing = total === 0;
    const actions: CardActions = { busy, accept: acceptField, reject };

    return (
        <EntityDetailLayout
            id="session-review"
            breadcrumbs={[
                { label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) },
                { label: interviewTitle, href: APP_ROUTES.interview(workspaceSlug, book.id, review.session.id) },
                { label: t('breadcrumbReview') },
            ]}
            title={t('title')}
            meta={<span className="text-sm text-content-muted">{t('description')}</span>}
            actions={
                <Link href={APP_ROUTES.interview(workspaceSlug, book.id, review.session.id)} className="text-sm text-content-emphasis hover:underline" id="review-back">
                    {t('backToInterview')}
                </Link>
            }
        >
            <div className="space-y-section">
                {!canEdit ? <p className="text-sm text-content-muted">{t('readOnly')}</p> : null}
                {review.truncated ? <p className="text-sm text-content-warning">{t('truncated', { count: total })}</p> : null}

                {review.runs.length > 0 ? (
                    <section aria-labelledby="review-runs-title" className="space-y-tight">
                        <h2 id="review-runs-title" className="text-base font-semibold text-content-emphasis">
                            {t('runsTitle')}
                        </h2>
                        <ul className="space-y-tight" data-testid="reconcile-runs">
                            {review.runs.map((r, i) => (
                                <li key={`${r.roundNumber ?? 'x'}-${i}`} className="flex flex-wrap items-center gap-tight text-sm" data-testid="reconcile-run" data-outcome={r.outcome ?? r.status}>
                                    <span className="font-medium text-content-emphasis">{r.roundNumber !== null ? t('roundLabel', { number: r.roundNumber }) : null}</span>
                                    <span className="text-content-default">{t(`runStatus.${r.outcome ?? 'RUNNING'}`)}</span>
                                    {r.reviewRequired ? <span className="text-content-warning">{t('guardFlag')}</span> : null}
                                    {canEdit && (r.status === 'FAILED' || r.status === 'REFUSED') && r.roundNumber !== null ? (
                                        <Button variant="secondary" size="sm" icon={<RotateCcw className="size-4" aria-hidden="true" />} disabled={busy} onClick={() => void retry(r.roundNumber!)} id={`retry-round-${r.roundNumber}`}>
                                            {t('runRetry')}
                                        </Button>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}

                {nothing ? <EmptyState title={t('emptyTitle')} description={t('empty')} /> : null}

                {review.fields.length > 0 ? (
                    <section aria-labelledby="review-fields-title" className="space-y-default">
                        <div className="flex flex-wrap items-center justify-between gap-tight">
                            <h2 id="review-fields-title" className="text-base font-semibold text-content-emphasis">
                                {t('fieldsTitle')}
                            </h2>
                            {canEdit && eligible.length > 0 ? (
                                <Button variant="primary" icon={<Check className="size-4" aria-hidden="true" />} loading={busy} onClick={() => void bulk()} id="bulk-accept">
                                    {t('bulkAccept', { count: eligible.length })}
                                </Button>
                            ) : null}
                        </div>
                        {canEdit && eligible.length > 0 ? <p className="text-xs text-content-muted">{t('bulkHelp')}</p> : null}
                        {review.fields.map((p) => (
                            <FieldProposalCard key={p.id} p={p} answers={review.answers} canEdit={canEdit} actions={actions} scaleOf={scaleOf} workspaceSlug={workspaceSlug} bookId={book.id} />
                        ))}
                    </section>
                ) : null}

                {review.relationFields.length > 0 ? (
                    <section aria-labelledby="review-relation-fields-title" className="space-y-default">
                        <h2 id="review-relation-fields-title" className="text-base font-semibold text-content-emphasis">
                            {t('relationFieldsTitle')}
                        </h2>
                        <p className="text-sm text-content-muted">{t('relationFieldsHelp')}</p>
                        {review.relationFields.map((p) => (
                            <FieldProposalCard key={p.id} p={p} answers={review.answers} canEdit={canEdit} actions={actions} scaleOf={scaleOf} workspaceSlug={workspaceSlug} bookId={book.id} />
                        ))}
                    </section>
                ) : null}

                {review.newElements.length > 0 ? (
                    <section aria-labelledby="review-new-title" className="space-y-default">
                        <h2 id="review-new-title" className="text-base font-semibold text-content-emphasis">
                            {t('newElementsTitle')}
                        </h2>
                        <p className="text-sm text-content-muted">{t('newElementsHelp')}</p>
                        {review.newElements.map((p) => (
                            <NewElementCard
                                key={p.id}
                                p={p}
                                answers={review.answers}
                                canEdit={canEdit}
                                busy={busy}
                                kindLabel={kindLabels[p.newKind] ?? p.newKind}
                                onAccept={acceptNew}
                                onReject={reject}
                                workspaceSlug={workspaceSlug}
                                bookId={book.id}
                            />
                        ))}
                    </section>
                ) : null}

                {review.newRelations.length > 0 ? (
                    <section aria-labelledby="review-new-relations-title" className="space-y-default">
                        <h2 id="review-new-relations-title" className="text-base font-semibold text-content-emphasis">
                            {t('newRelationsTitle')}
                        </h2>
                        <p className="text-sm text-content-muted">{t('newRelationsHelp')}</p>
                        {review.newRelations.map((p) => (
                            <NewRelationCard key={p.id} p={p} answers={review.answers} canEdit={canEdit} busy={busy} onAccept={acceptRelation} onReject={reject} />
                        ))}
                    </section>
                ) : null}
            </div>
        </EntityDetailLayout>
    );
}
