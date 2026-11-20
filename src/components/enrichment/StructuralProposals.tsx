'use client';

/**
 * The parts of a proposal the review page and a story map's list share
 * (Phase 3.3, decision D24): the answers a proposal is drawn from, its D14
 * warning, a new relation as the author reads it, and a new element's first
 * fields. Values render as text (`FieldEditor` read-only), never as HTML.
 *
 * `NewRelationCard` is the record of a proposed relation: its two ends and
 * type's label, its note and fields, the answers it cites, and Accept /
 * Reject for an editor. A relation that joins a new entry waits for that
 * entry: Accept is offered only once both ends exist (the server holds the
 * same rule, 409 END_NOT_CREATED).
 */
import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { FieldEditor } from '@/components/bible/FieldEditor';
import type { FieldValue } from '@/lib/bible/field-values';
import type { FieldDef } from '@/lib/bible/template-schema';
import type { CitedAnswerView, NewRelationProposalView } from '@/lib/enrichment/api-client';

const noop = () => {};

export function ProposalSources({ ids, answers }: { ids: readonly string[]; answers: Record<string, CitedAnswerView> }) {
    const t = useTranslations('enrichment');
    return (
        <div className="space-y-tight">
            <p className="text-xs font-medium uppercase tracking-wide text-content-muted">{t('citesTitle')}</p>
            <ul className="space-y-tight" data-testid="proposal-sources">
                {ids.map((id) => {
                    const a = answers[id];
                    return (
                        <li key={id} className="rounded-md border border-border-subtle bg-bg-muted p-2 text-sm">
                            {a ? (
                                <>
                                    <p className="text-content-muted">{a.question}</p>
                                    <p className="whitespace-pre-wrap text-content-default">{a.answer ?? t('notAnswered')}</p>
                                </>
                            ) : (
                                <p className="text-content-muted">{t('answerMissing')}</p>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** The warnings a proposal carries (D14), each a badge and a sentence saying what it means. */
export function ProposalFlags({ id, flags }: { id: string; flags: readonly string[] }) {
    const t = useTranslations('enrichment.flag');
    if (flags.length === 0) return null;
    return (
        <div className="space-y-tight rounded-md border border-border-emphasis bg-bg-subtle p-3" data-testid="proposal-flag" id={`proposal-${id}-flags`}>
            {flags.map((f) => (
                <div key={f} className="space-y-1">
                    <StatusBadge variant="warning">{t(`${f}.label`)}</StatusBadge>
                    <p className="text-sm text-content-default">{t(`${f}.explained`)}</p>
                </div>
            ))}
        </div>
    );
}

export function proposalStatusVariant(status: string): 'info' | 'success' | 'neutral' | 'warning' {
    if (status === 'PENDING') return 'info';
    if (status === 'ACCEPTED' || status === 'EDITED_ACCEPTED') return 'success';
    return 'neutral';
}

/** A proposal's first field values as text (a new element's, a new relation's). */
export function ProposedFields({ fields, title }: { fields: ReadonlyArray<{ field: FieldDef; value: FieldValue }>; title?: string }) {
    if (fields.length === 0) return null;
    return (
        <div className="space-y-tight" data-testid="proposal-fields">
            {title ? <p className="text-xs font-medium uppercase tracking-wide text-content-muted">{title}</p> : null}
            {fields.map((f) => (
                <FieldEditor key={f.field.key} def={f.field} value={f.value} onChange={noop} readOnly />
            ))}
        </div>
    );
}

/** A proposed relation: "A — label — B", worded the same everywhere it is shown. */
export function relationWords(p: Pick<NewRelationProposalView, 'from' | 'to' | 'label'>): { from: string; label: string; to: string } {
    return { from: p.from.name, label: p.label, to: p.to.name };
}

export function NewRelationCard({
    p,
    answers,
    canEdit,
    busy,
    onAccept,
    onReject,
    headingLevel = 3,
}: {
    p: NewRelationProposalView;
    answers: Record<string, CitedAnswerView>;
    canEdit: boolean;
    busy: boolean;
    onAccept: (p: NewRelationProposalView) => Promise<boolean>;
    onReject: (id: string) => Promise<void>;
    headingLevel?: 3 | 4;
}) {
    const t = useTranslations('enrichment');
    const pending = p.status === 'PENDING';
    const words = relationWords(p);
    const headingId = `proposal-${p.id}-title`;
    const Heading = headingLevel === 3 ? 'h3' : 'h4';
    // The end that waits for its own acceptance (a new entry), if any.
    const waiting = !p.from.exists ? p.from : !p.to.exists ? p.to : null;
    const ready = waiting === null;
    return (
        <Card className="space-y-default p-5" id={`proposal-${p.id}`} data-testid="new-relation-proposal" data-status={p.status} aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-tight">
                <Heading id={headingId} className="min-w-0 text-base font-semibold text-content-emphasis">
                    {words.from} <span className="font-normal text-content-muted">{words.label}</span> {words.to}
                </Heading>
                <StatusBadge variant={proposalStatusVariant(p.status)} data-testid="proposal-status">
                    {t(`status.${p.status}`)}
                </StatusBadge>
            </div>
            {pending ? <ProposalFlags id={p.id} flags={p.flags} /> : null}
            {p.note ? (
                <div className="space-y-1">
                    <p className="text-sm font-medium text-content-emphasis">{t('relationNote')}</p>
                    <p className="whitespace-pre-wrap text-sm text-content-default">{p.note}</p>
                </div>
            ) : null}
            <ProposedFields fields={p.fields} />
            {pending && waiting ? (
                <p className="rounded-md border border-border-default bg-bg-subtle p-3 text-sm text-content-default" data-testid="relation-waits">
                    {waiting.proposalId ? t('relationWaits', { name: waiting.name }) : t('relationEndGone')}
                </p>
            ) : null}
            <ProposalSources ids={p.citedAnswerIds} answers={answers} />
            {canEdit && pending ? (
                <div className="flex flex-wrap items-center gap-tight">
                    <Button
                        variant="primary"
                        icon={<Check className="size-4" aria-hidden="true" />}
                        loading={busy}
                        disabled={!ready}
                        onClick={() => void onAccept(p)}
                        aria-label={t('acceptRelationAria', words)}
                        id={`accept-${p.id}`}
                    >
                        {t('accept')}
                    </Button>
                    <Button
                        variant="secondary"
                        icon={<X className="size-4" aria-hidden="true" />}
                        disabled={busy}
                        onClick={() => void onReject(p.id)}
                        aria-label={t('rejectRelationAria', words)}
                        id={`reject-${p.id}`}
                    >
                        {t('reject')}
                    </Button>
                </div>
            ) : null}
        </Card>
    );
}
