'use client';

/**
 * The book's pending new elements and relations, listed beside a story map
 * (Phase 3.3, D24). THE LIST IS THE RECORD: every pending structural proposal
 * is here as plain text — its name or its two ends, its first fields, the
 * answers it is drawn from — whether or not the canvas draws its ghost, and
 * whether or not the canvas loaded at all (this component carries no tldraw
 * and sits outside the canvas's error boundary).
 *
 * An editor accepts or rejects each one here, by keyboard as well as pointer,
 * through the session's ordinary review routes (the same rules as the review
 * page: a relation that joins a new entry waits for it). What is accepted is
 * handed to the map (`onAccepted`), which adds a card or an edge through its
 * own save. A reader reads.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/components/ui/hooks';
import { StatusBadge } from '@/components/ui/status-badge';
import { NewRelationCard, ProposalFlags, ProposalSources, ProposedFields } from '@/components/enrichment/StructuralProposals';
import { APP_ROUTES } from '@/lib/app-routes';
import { BibleApiError } from '@/lib/bible/api-client';
import type { AcceptedStructure } from '@/lib/canvas/structure-preview';
import { enrichmentApi, type CitedAnswerView, type NewElementProposalView, type NewRelationProposalView, type PendingStructureResult, type PendingStructureView } from '@/lib/enrichment/api-client';

export interface PendingStructureListProps {
    workspaceSlug: string;
    bookId: string;
    canEdit: boolean;
    kindLabels: Readonly<Record<string, string>>;
    /** The kinds this map draws (its section names them first). */
    drawnKinds: readonly string[];
    /** What the list now holds (the canvas draws the same proposals as ghosts). */
    onLoaded?: (proposals: readonly PendingStructureView[]) => void;
    onAccepted?: (accepted: AcceptedStructure) => void;
    /** The canvas could not draw its preview. */
    previewFailed?: boolean;
}

/** The refusals worded in `enrichment.errors` that mean the list is out of date: read it again. */
const RELOAD_ON: ReadonlySet<string> = new Set(['PROPOSAL_DECIDED', 'PROPOSAL_STALE', 'RELATION_EXISTS', 'END_NOT_CREATED', 'END_GONE', 'ELEMENT_EXISTS']);

function NewElementItem({
    p,
    answers,
    canEdit,
    busy,
    kindLabel,
    onAccept,
    onReject,
    reviewHref,
}: {
    p: NewElementProposalView;
    answers: Record<string, CitedAnswerView>;
    canEdit: boolean;
    busy: boolean;
    kindLabel: string;
    onAccept: (p: NewElementProposalView) => Promise<boolean>;
    onReject: (id: string) => Promise<void>;
    reviewHref: string;
}) {
    const t = useTranslations('enrichment');
    const tc = useTranslations('canvas.structure');
    const headingId = `proposal-${p.id}-title`;
    return (
        <Card className="space-y-default p-4" id={`proposal-${p.id}`} data-testid="structure-new-element" data-status={p.status} aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-tight">
                <div className="min-w-0 space-y-1">
                    <h4 id={headingId} className="text-base font-semibold text-content-emphasis">
                        {p.name}
                    </h4>
                    <p className="text-sm text-content-muted">{t('kindLabel', { kind: kindLabel })}</p>
                </div>
                <StatusBadge variant="info">{tc('proposed')}</StatusBadge>
            </div>
            <ProposalFlags id={p.id} flags={p.flags} />
            {p.summary ? <p className="whitespace-pre-wrap text-sm text-content-default">{p.summary}</p> : null}
            {p.slot ? (
                <p className="text-sm text-content-muted" data-testid="slot-placement">
                    {t('slotPlacement', { a: p.slot.afterName, b: p.slot.beforeName })}
                </p>
            ) : null}
            <ProposedFields fields={p.fields} title={t('firstFields')} />
            <ProposalSources ids={p.citedAnswerIds} answers={answers} />
            <div className="flex flex-wrap items-center gap-tight">
                {canEdit ? (
                    <>
                        <Button variant="primary" icon={<Check className="size-4" aria-hidden="true" />} loading={busy} onClick={() => void onAccept(p)} aria-label={tc('acceptAria', { name: p.name })} id={`accept-${p.id}`}>
                            {t('accept')}
                        </Button>
                        <Button variant="secondary" icon={<X className="size-4" aria-hidden="true" />} disabled={busy} onClick={() => void onReject(p.id)} aria-label={tc('rejectAria', { name: p.name })} id={`reject-${p.id}`}>
                            {t('reject')}
                        </Button>
                    </>
                ) : null}
                <Link href={reviewHref} className="text-sm text-content-emphasis hover:underline">
                    {tc('openReview')}
                </Link>
            </div>
        </Card>
    );
}

export function PendingStructureList({ workspaceSlug, bookId, canEdit, kindLabels, drawnKinds, onLoaded, onAccepted, previewFailed = false }: PendingStructureListProps) {
    const t = useTranslations('canvas.structure');
    const te = useTranslations('enrichment');
    const tErr = useTranslations('enrichment.errors');
    const toast = useToast();
    const [data, setData] = useState<PendingStructureResult | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);

    const apply = useCallback(
        (result: PendingStructureResult) => {
            setData(result);
            setFailed(false);
            onLoaded?.(result.proposals);
        },
        [onLoaded],
    );
    const load = useCallback(async () => {
        try {
            apply(await enrichmentApi.pendingStructure(workspaceSlug, bookId));
        } catch {
            setFailed(true);
        }
    }, [workspaceSlug, bookId, apply]);
    useEffect(() => {
        let live = true;
        enrichmentApi
            .pendingStructure(workspaceSlug, bookId)
            .then((result) => live && apply(result))
            .catch(() => live && setFailed(true));
        return () => {
            live = false;
        };
    }, [workspaceSlug, bookId, apply]);

    const decide = useCallback(
        async (p: PendingStructureView, action: 'accept' | 'reject'): Promise<boolean> => {
            setBusy(true);
            const ids = { slug: workspaceSlug, bookId, sessionId: p.sessionId };
            try {
                if (action === 'reject') {
                    await enrichmentApi.reject(ids, p.id);
                    toast.success(te('rejected'));
                } else {
                    const { decision } = await enrichmentApi.accept(ids, p.id, {});
                    if (p.kind === 'NEW_ELEMENT' && decision.elementId) {
                        toast.success(te('acceptedNew', { name: p.name }));
                        onAccepted?.({ kind: 'NEW_ELEMENT', elementId: decision.elementId, name: p.name, elementKind: p.newKind, filledFieldCount: p.fields.length });
                    } else if (p.kind === 'NEW_RELATION' && decision.relationId && p.from.elementId && p.to.elementId) {
                        toast.success(te('acceptedRelation'));
                        onAccepted?.({ kind: 'NEW_RELATION', relationId: decision.relationId, sourceElementId: p.from.elementId, targetElementId: p.to.elementId, label: p.label });
                    }
                }
                await load();
                return true;
            } catch (err) {
                const reason = err instanceof BibleApiError ? err.reason : null;
                toast.error(reason && tErr.has(reason) ? tErr(reason) : tErr('generic'));
                if (reason && RELOAD_ON.has(reason)) await load();
                return false;
            } finally {
                setBusy(false);
            }
        },
        [workspaceSlug, bookId, toast, te, tErr, onAccepted, load],
    );

    const { elements, relations } = useMemo(() => {
        const proposals = data?.proposals ?? [];
        const drawn = new Set(drawnKinds);
        const newElements = proposals.filter((p): p is NewElementProposalView & { sessionId: string } => p.kind === 'NEW_ELEMENT');
        // This map's kinds first, then the rest (each still listed: the list is the record).
        newElements.sort((a, b) => Number(drawn.has(b.newKind)) - Number(drawn.has(a.newKind)));
        return { elements: newElements, relations: proposals.filter((p): p is NewRelationProposalView & { sessionId: string } => p.kind === 'NEW_RELATION') };
    }, [data, drawnKinds]);

    if (failed) {
        return (
            <p className="text-sm text-content-muted" data-testid="structure-list-failed">
                {t('loadFailed')}
            </p>
        );
    }
    if (!data || (elements.length === 0 && relations.length === 0)) return null;
    return (
        <section aria-labelledby="structure-list-title" className="space-y-default rounded-md border border-border-default p-4" data-testid="structure-list">
            <div className="space-y-1">
                <h2 id="structure-list-title" className="text-base font-semibold text-content-emphasis">
                    {t('title')}
                </h2>
                <p className="text-sm text-content-muted">{canEdit ? t('help') : t('helpReader')}</p>
                {previewFailed ? (
                    <p className="text-sm text-content-warning" data-testid="structure-preview-failed">
                        {t('previewFailed')}
                    </p>
                ) : null}
                {data.truncated ? <p className="text-sm text-content-muted">{t('truncated', { count: data.proposals.length })}</p> : null}
            </div>
            {elements.length > 0 ? (
                <div className="space-y-tight">
                    <h3 className="text-sm font-semibold text-content-emphasis">{te('newElementsTitle')}</h3>
                    {elements.map((p) => (
                        <NewElementItem
                            key={p.id}
                            p={p}
                            answers={data.answers}
                            canEdit={canEdit}
                            busy={busy}
                            kindLabel={kindLabels[p.newKind] ?? p.newKind}
                            onAccept={(q) => decide({ ...q, sessionId: p.sessionId }, 'accept')}
                            onReject={() => decide(p, 'reject').then(() => undefined)}
                            reviewHref={APP_ROUTES.interviewReview(workspaceSlug, bookId, p.sessionId)}
                        />
                    ))}
                </div>
            ) : null}
            {relations.length > 0 ? (
                <div className="space-y-tight">
                    <h3 className="text-sm font-semibold text-content-emphasis">{te('newRelationsTitle')}</h3>
                    {relations.map((p) => (
                        <NewRelationCard
                            key={p.id}
                            p={p}
                            answers={data.answers}
                            canEdit={canEdit}
                            busy={busy}
                            headingLevel={4}
                            onAccept={() => decide(p, 'accept')}
                            onReject={() => decide(p, 'reject').then(() => undefined)}
                        />
                    ))}
                </div>
            ) : null}
        </section>
    );
}
