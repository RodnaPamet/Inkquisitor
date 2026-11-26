'use client';

/**
 * Possible contradictions (Phase 4.1, D27), on a book's Facts page: each
 * pending proposal to invalidate a fact, with both facts quoted and where each
 * came from (a bible entry and its version, or a source). Nothing was changed
 * when the proposal was raised; the author decides — the older fact no longer
 * holds, both are true, or it is not a contradiction. `canEdit` is
 * `bible.edit`; a reader reads. Every text renders as text.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { BibleApiError } from '@/lib/bible/api-client';
import type { FactProposalDecision } from '@/lib/facts/vocabulary';
import { sourcesApi, type FactProposalsPage, type FactProposalView, type ProposalFactView } from '@/lib/sources/api-client';

export interface FactProposalsPanelProps {
    workspaceSlug: string;
    bookId: string;
    initial: FactProposalsPage;
    canEdit: boolean;
}

function FactLine({ fact, label }: { fact: ProposalFactView; label: string }) {
    const t = useTranslations('sources.proposals');
    const tf = useTranslations('sources.facts');
    const origin =
        fact.origin.kind === 'ELEMENT'
            ? fact.origin.elementName
                ? fact.origin.versionNumber !== null
                    ? t('originElement', { element: fact.origin.elementName, version: fact.origin.versionNumber })
                    : t('originElementNoVersion', { element: fact.origin.elementName })
                : t('originUnknown')
            : fact.origin.kind === 'RELATION'
              ? fact.origin.label
                  ? t('originRelation', { relation: fact.origin.label })
                  : t('originUnknown')
              : fact.origin.filename
                ? t('originSource', { file: fact.origin.filename, version: fact.origin.version ?? 1 })
                : t('originUnknown');
    return (
        <div className="space-y-tight" data-testid="proposal-fact">
            <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{label}</p>
            <p className="text-sm text-content-emphasis">{fact.statement}</p>
            <p className="text-xs text-content-muted">
                {tf('about', { subject: fact.subjectName, predicate: tf.has(`predicate.${fact.predicate}`) ? tf(`predicate.${fact.predicate}`) : fact.predicate })}
                {fact.storyTimeFrom || fact.storyTimeTo ? ` · ${tf('when', { from: fact.storyTimeFrom ?? '', to: fact.storyTimeTo ?? '' })}` : ''}
            </p>
            <blockquote className="border-l-2 border-border-subtle pl-default text-sm text-content-default">{fact.quote}</blockquote>
            <p className="text-xs text-content-muted">{origin}</p>
        </div>
    );
}

function ProposalCard({ proposal, canEdit, onDecide }: { proposal: FactProposalView; canEdit: boolean; onDecide: (p: FactProposalView, d: FactProposalDecision) => Promise<void> }) {
    const t = useTranslations('sources.proposals');
    const [busy, setBusy] = useState(false);
    const decide = async (d: FactProposalDecision) => {
        setBusy(true);
        try {
            await onDecide(proposal, d);
        } finally {
            setBusy(false);
        }
    };
    return (
        <Card className="space-y-default p-default" data-testid="fact-proposal" aria-label={proposal.reason === 'CONTRADICTED' ? t('contradicted') : t('noLongerStated')}>
            <h3 className="text-sm font-semibold text-content-emphasis">{proposal.reason === 'CONTRADICTED' ? t('contradicted') : t('noLongerStated')}</h3>
            <p className="text-xs text-content-muted">{t(`basis.${proposal.basis}`)}</p>
            <div className="grid gap-default md:grid-cols-2">
                <FactLine fact={proposal.older} label={t('older')} />
                {proposal.newer ? <FactLine fact={proposal.newer} label={t('newer')} /> : null}
            </div>
            {canEdit ? (
                <div className="flex flex-wrap gap-tight">
                    <Button type="button" variant="primary" disabled={busy} onClick={() => decide('INVALIDATE')} data-testid="proposal-invalidate">
                        {proposal.newer ? t('invalidate') : t('invalidateGone')}
                    </Button>
                    {proposal.newer ? (
                        <Button type="button" variant="secondary" disabled={busy} onClick={() => decide('KEEP_BOTH')} data-testid="proposal-keep-both">
                            {t('keepBoth')}
                        </Button>
                    ) : null}
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => decide('REJECT')} data-testid="proposal-reject">
                        {t('reject')}
                    </Button>
                </div>
            ) : null}
        </Card>
    );
}

export function FactProposalsPanel({ workspaceSlug, bookId, initial, canEdit }: FactProposalsPanelProps) {
    const t = useTranslations('sources.proposals');
    const reasons = useTranslations('sources.reasons');
    const [page, setPage] = useState(initial);
    const onDecide = async (p: FactProposalView, d: FactProposalDecision) => {
        try {
            await sourcesApi.decideProposal(workspaceSlug, bookId, p.id, d);
            toast.success(t('decided'));
        } catch (err) {
            const reason = err instanceof BibleApiError ? err.reason : null;
            toast.error(reason && reasons.has(reason) ? reasons(reason) : reasons('generic'));
        }
        try {
            setPage(await sourcesApi.proposals(workspaceSlug, bookId));
        } catch {
            // The list stays as it was; the next load reads it again.
        }
    };
    if (page.pending === 0) return null;
    return (
        <section className="space-y-default" aria-labelledby="fact-proposals-title" id="fact-proposals">
            <div className="flex flex-wrap items-baseline justify-between gap-tight">
                <h2 id="fact-proposals-title" className="text-base font-semibold text-content-emphasis">
                    {t('title')}
                </h2>
                <span className="text-sm text-content-muted">{t('count', { count: page.pending })}</span>
            </div>
            <p className="text-sm text-content-muted">{t('help')}</p>
            {page.proposals.map((p) => (
                <ProposalCard key={p.id} proposal={p} canEdit={canEdit} onDecide={onDecide} />
            ))}
            {page.truncated ? <p className="text-sm text-content-muted">{t('truncated', { shown: page.proposals.length })}</p> : null}
        </section>
    );
}
