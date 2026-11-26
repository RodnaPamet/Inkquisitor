'use client';

/**
 * A book's Continuity page (Phase 4.2, D28). Every finding here was PROPOSED
 * (rule 1): the author decides.
 *
 *   • whether anything has been checked (rule 6: no live fact reads "not
 *     assessed", never "no contradictions"), and the nightly check's last run;
 *   • contradictions, each with both facts quoted and where each came from —
 *     keep the newer, keep the older, both are true (and say how: it becomes a
 *     fact), or not a contradiction; facts their entries no longer state;
 *   • promises, clues and open questions (added, edited, closed and removed by
 *     hand; a removal goes through the undo toast), the threads proposed (each
 *     citing the entry and its words; a flagged one says so), and "decide later"
 *     answers still open;
 *   • entries that may be stale, each with "Grill me on what changed" (an
 *     interview scoped to the entry, the change as its context) and Dismiss.
 *
 * `canEdit` is `bible.edit`, passed down; a reader reads. Every text renders as
 * text. Refusals are worded from their `details.reason`.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { useToastWithUndo } from '@/components/ui/hooks';
import { APP_ROUTES } from '@/lib/app-routes';
import { BibleApiError } from '@/lib/bible/api-client';
import { continuityApi, type ContinuityPage as PageData, type StaleFlagView, type ThreadProposalView, type ThreadView } from '@/lib/continuity/api-client';
import { THREAD_KINDS, THREAD_STATES, type ThreadKind } from '@/lib/continuity/vocabulary';
import type { FactProposalDecision } from '@/lib/facts/vocabulary';
import { CODE_SETUP_DEFAULTS, interviewSetupQuery } from '@/lib/interview/setup';
import type { FactProposalView, ProposalFactView } from '@/lib/sources/api-client';

export interface ContinuityPageProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    initial: PageData;
    canEdit: boolean;
}

function useReasonText() {
    const reasons = useTranslations('continuity.reasons');
    return (err: unknown) => {
        const reason = err instanceof BibleApiError ? err.reason : null;
        return reason && reasons.has(reason) ? reasons(reason) : reasons('generic');
    };
}

function FactLine({ fact, label }: { fact: ProposalFactView; label: string }) {
    const t = useTranslations('continuity.facts');
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
              : fact.origin.kind === 'AUTHOR'
                ? t('originAuthor')
                : fact.origin.filename
                  ? t('originSource', { file: fact.origin.filename, version: fact.origin.version ?? 1 })
                  : t('originUnknown');
    return (
        <div className="space-y-tight" data-testid="continuity-fact">
            <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{label}</p>
            <p className="text-sm text-content-emphasis">{fact.statement}</p>
            <p className="text-xs text-content-muted">
                {fact.subjectName}
                {fact.storyTimeFrom || fact.storyTimeTo ? ` · ${t('when', { from: fact.storyTimeFrom ?? '', to: fact.storyTimeTo ?? '' })}` : ''}
            </p>
            <blockquote className="border-l-2 border-border-subtle pl-default text-sm text-content-default">{fact.quote}</blockquote>
            <p className="text-xs text-content-muted">{origin}</p>
        </div>
    );
}

function ContradictionCard({ proposal, canEdit, onDecide }: { proposal: FactProposalView; canEdit: boolean; onDecide: (p: FactProposalView, d: FactProposalDecision, explanation?: string) => Promise<boolean> }) {
    const t = useTranslations('continuity.contradictions');
    const [busy, setBusy] = useState(false);
    const [explaining, setExplaining] = useState(false);
    const [explanation, setExplanation] = useState('');
    const [touched, setTouched] = useState(false);
    const decide = async (d: FactProposalDecision, text?: string) => {
        setBusy(true);
        try {
            return await onDecide(proposal, d, text);
        } finally {
            setBusy(false);
        }
    };
    const heading = proposal.newer ? t(`kind.${proposal.kind ?? 'OTHER'}`) : t('noLongerStated');
    return (
        <Card className="space-y-default p-default" data-testid="continuity-contradiction" aria-label={heading}>
            <div className="flex flex-wrap items-baseline justify-between gap-tight">
                <h3 className="text-sm font-semibold text-content-emphasis">{heading}</h3>
                <span className="text-xs text-content-muted">{t(`basis.${proposal.basis}`)}</span>
            </div>
            <div className="grid gap-default md:grid-cols-2">
                <FactLine fact={proposal.older} label={t('older')} />
                {proposal.newer ? <FactLine fact={proposal.newer} label={t('newer')} /> : null}
            </div>
            {canEdit ? (
                <div className="flex flex-wrap gap-tight">
                    {proposal.newer ? (
                        <>
                            <Button type="button" variant="primary" disabled={busy} onClick={() => decide('INVALIDATE')} data-testid="contradiction-keep-newer">
                                {t('keepNewer')}
                            </Button>
                            <Button type="button" variant="secondary" disabled={busy} onClick={() => decide('INVALIDATE_NEWER')} data-testid="contradiction-keep-older">
                                {t('keepOlder')}
                            </Button>
                            <Button type="button" variant="secondary" disabled={busy} onClick={() => setExplaining(true)} data-testid="contradiction-both-true">
                                {t('bothTrue')}
                            </Button>
                        </>
                    ) : (
                        <Button type="button" variant="primary" disabled={busy} onClick={() => decide('INVALIDATE')} data-testid="contradiction-retire">
                            {t('retire')}
                        </Button>
                    )}
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => decide(proposal.newer ? 'REJECT' : 'KEEP_BOTH')} data-testid="contradiction-reject">
                        {proposal.newer ? t('notContradiction') : t('stillTrue')}
                    </Button>
                </div>
            ) : null}
            <Modal showModal={explaining} setShowModal={setExplaining} title={t('explainTitle')}>
                <Modal.Form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        setTouched(true);
                        if (explanation.trim() === '') return;
                        if (await decide('KEEP_BOTH', explanation)) setExplaining(false);
                    }}
                >
                    <Modal.Header title={t('explainTitle')} description={t('explainHelp')} />
                    <Modal.Body className="space-y-default">
                        <FormField label={t('explanation')} required error={touched && explanation.trim() === '' ? t('explanationRequired') : undefined}>
                            <Textarea id="contradiction-explanation" value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={4} />
                        </FormField>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button type="button" variant="secondary" onClick={() => setExplaining(false)}>
                            {t('cancel')}
                        </Button>
                        <Button type="submit" variant="primary" loading={busy} id="contradiction-explanation-submit">
                            {t('saveExplanation')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>
        </Card>
    );
}

function ThreadModal({ open, setOpen, initial, onSave }: { open: boolean; setOpen: (v: boolean) => void; initial: ThreadView | null; onSave: (draft: { kind: ThreadKind; title: string; note: string | null }) => Promise<boolean> }) {
    const t = useTranslations('continuity.threads');
    const [kind, setKind] = useState<ThreadKind>(initial?.kind ?? 'PROMISE');
    const [title, setTitle] = useState(initial?.title ?? '');
    const [note, setNote] = useState(initial?.note ?? '');
    const [touched, setTouched] = useState(false);
    const [saving, setSaving] = useState(false);
    return (
        <Modal showModal={open} setShowModal={(v) => setOpen(typeof v === 'function' ? v(open) : v)} title={initial ? t('editTitle') : t('addTitle')}>
            <Modal.Form
                onSubmit={async (e) => {
                    e.preventDefault();
                    setTouched(true);
                    if (title.trim() === '') return;
                    setSaving(true);
                    try {
                        if (await onSave({ kind, title, note: note.trim() === '' ? null : note })) setOpen(false);
                    } finally {
                        setSaving(false);
                    }
                }}
            >
                <Modal.Header title={initial ? t('editTitle') : t('addTitle')} description={t('addHelp')} />
                <Modal.Body className="space-y-default">
                    {initial ? null : (
                        <FormField label={t('kindLabel')}>
                            <ToggleGroup ariaLabel={t('kindLabel')} options={THREAD_KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))} selected={kind} selectAction={(v: string) => setKind(v as ThreadKind)} />
                        </FormField>
                    )}
                    <FormField label={t('titleLabel')} required error={touched && title.trim() === '' ? t('titleRequired') : undefined}>
                        <Input id="thread-title" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
                    </FormField>
                    <FormField label={t('noteLabel')}>
                        <Textarea id="thread-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
                    </FormField>
                </Modal.Body>
                <Modal.Actions>
                    <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                        {t('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" loading={saving} id="thread-submit">
                        {t('save')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}

function ThreadRow({ thread, canEdit, onState, onEdit, onRemove }: { thread: ThreadView; canEdit: boolean; onState: (t: ThreadView, state: string) => void; onEdit: (t: ThreadView) => void; onRemove: (t: ThreadView) => void }) {
    const t = useTranslations('continuity.threads');
    const others = THREAD_STATES[thread.kind].filter((s) => s !== thread.state);
    return (
        <li className="space-y-tight py-default" data-testid="continuity-thread">
            <div className="flex flex-wrap items-baseline justify-between gap-tight">
                <p className="text-sm text-content-emphasis">{thread.title}</p>
                <StatusBadge variant={thread.state === 'OPEN' ? 'info' : 'neutral'}>{t(`state.${thread.state}`)}</StatusBadge>
            </div>
            {thread.note ? <p className="text-sm text-content-muted">{thread.note}</p> : null}
            {thread.subjectName ? <p className="text-xs text-content-muted">{t('about', { name: thread.subjectName })}</p> : null}
            {canEdit ? (
                <div className="flex flex-wrap gap-tight">
                    {others.map((s) => (
                        <Button key={s} type="button" size="sm" variant="secondary" onClick={() => onState(thread, s)} data-testid={`thread-state-${s}`}>
                            {t(`move.${s}`)}
                        </Button>
                    ))}
                    <Button type="button" size="sm" variant="secondary" onClick={() => onEdit(thread)}>
                        {t('edit')}
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => onRemove(thread)} data-testid="thread-remove">
                        {t('remove')}
                    </Button>
                </div>
            ) : null}
        </li>
    );
}

function ThreadProposalCard({ proposal, canEdit, onDecide }: { proposal: ThreadProposalView; canEdit: boolean; onDecide: (p: ThreadProposalView, d: 'ACCEPT' | 'REJECT') => void }) {
    const t = useTranslations('continuity.threadProposals');
    const tt = useTranslations('continuity.threads');
    const flagged = proposal.flags.includes('POSSIBLE_INSTRUCTION');
    return (
        <Card className="space-y-tight p-default" data-testid="continuity-thread-proposal">
            <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{tt(`kind.${proposal.kind}`)}</p>
            <p className="text-sm text-content-emphasis">
                {proposal.op === 'NEW_THREAD' ? proposal.title : t('paysOff', { title: proposal.threadTitle ?? '', state: tt(`state.${proposal.proposedState}`) })}
            </p>
            <blockquote className="border-l-2 border-border-subtle pl-default text-sm text-content-default">{proposal.quote}</blockquote>
            <p className="text-xs text-content-muted">
                {proposal.elementName ? (proposal.versionNumber !== null ? t('origin', { element: proposal.elementName, version: proposal.versionNumber }) : t('originNoVersion', { element: proposal.elementName })) : t('originUnknown')}
            </p>
            {flagged ? <p className="text-xs text-content-error">{t('flagged')}</p> : null}
            {canEdit ? (
                <div className="flex flex-wrap gap-tight">
                    <Button type="button" size="sm" variant="primary" onClick={() => onDecide(proposal, 'ACCEPT')} data-testid="thread-proposal-accept">
                        {t('accept')}
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => onDecide(proposal, 'REJECT')} data-testid="thread-proposal-reject">
                        {t('reject')}
                    </Button>
                </div>
            ) : null}
        </Card>
    );
}

function StaleRow({ workspaceSlug, bookId, flag, canEdit, onDismiss }: { workspaceSlug: string; bookId: string; flag: StaleFlagView; canEdit: boolean; onDismiss: (f: StaleFlagView) => void }) {
    const t = useTranslations('continuity.stale');
    const grill = APP_ROUTES.newInterview(
        workspaceSlug,
        bookId,
        interviewSetupQuery({ scope: 'SELECTION', elementIds: [flag.elementId], relationIds: [], staleFlagId: flag.id }, { ...CODE_SETUP_DEFAULTS, depth: 5, detail: 3, personaKeys: [], offerRecommended: true, preferChoice: false }),
    );
    return (
        <li className="space-y-tight py-default" data-testid="continuity-stale">
            <p className="text-sm text-content-emphasis">
                <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, flag.elementId)} className="underline">
                    {flag.elementName ?? t('unknownElement')}
                </Link>
            </p>
            <p className="text-sm text-content-muted">
                {flag.fromVersion !== null && flag.toVersion !== null
                    ? t('because', { upstream: flag.upstreamName ?? t('unknownElement'), from: flag.fromVersion, to: flag.toVersion })
                    : t('becauseNoVersions', { upstream: flag.upstreamName ?? t('unknownElement') })}
            </p>
            {canEdit ? (
                <div className="flex flex-wrap gap-tight">
                    <Link href={grill} className={buttonVariants({ variant: 'primary', size: 'sm' })} data-testid="stale-grill">
                        {t('grill')}
                    </Link>
                    <Button type="button" size="sm" variant="secondary" onClick={() => onDismiss(flag)} data-testid="stale-dismiss">
                        {t('dismiss')}
                    </Button>
                </div>
            ) : null}
        </li>
    );
}

export function ContinuityPage({ workspaceSlug, book, initial, canEdit }: ContinuityPageProps) {
    const t = useTranslations('continuity');
    const reasonText = useReasonText();
    const triggerUndo = useToastWithUndo();
    const [page, setPage] = useState(initial);
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<ThreadView | null>(null);

    const reload = async () => {
        try {
            setPage(await continuityApi.page(workspaceSlug, book.id));
        } catch {
            // The page stays as it was; the next load reads it again.
        }
    };
    const run = async (work: () => Promise<unknown>, done: string): Promise<boolean> => {
        try {
            await work();
            toast.success(done);
            await reload();
            return true;
        } catch (err) {
            toast.error(reasonText(err));
            await reload();
            return false;
        }
    };

    const threadsByKind = useMemo(() => {
        const out = new Map<ThreadKind, ThreadView[]>(THREAD_KINDS.map((k) => [k, []]));
        for (const th of page.threads.items) if (!hidden.has(th.id)) out.get(th.kind)?.push(th);
        return out;
    }, [page.threads.items, hidden]);

    const removeThread = (th: ThreadView) => {
        setHidden((h) => new Set([...h, th.id]));
        const unhide = () => setHidden((h) => new Set([...h].filter((x) => x !== th.id)));
        triggerUndo({
            message: t('threads.removed', { title: th.title }),
            undoMessage: t('threads.undo'),
            action: () => continuityApi.deleteThread(workspaceSlug, book.id, th.id, th.version),
            undoAction: unhide,
            onCommit: () => void reload().then(unhide, () => undefined),
            onError: (err: unknown) => {
                unhide();
                toast.error(reasonText(err));
            },
        });
    };

    const nightly = page.nightly;
    /** The last run's outcome in words; a pass that finished over a cut or passed-over set is never "every fact checked" (4.H-a). */
    const nightlyOutcomeText = (n: typeof nightly): string => {
        if (n.outcome === 'OK' && !n.complete) return t('nightly.outcome.OK_INCOMPLETE');
        return t.has(`nightly.outcome.${n.outcome}`) ? t(`nightly.outcome.${n.outcome}`) : (n.outcome ?? '');
    };
    return (
        <EntityDetailLayout
            id="continuity-page"
            breadcrumbs={[{ label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) }, { label: t('title') }]}
            title={t('title')}
            meta={
                <span className="text-sm text-content-muted" data-testid="continuity-status">
                    {page.assessed ? t('status.facts', { count: page.liveFacts }) : t('status.notAssessed')}
                </span>
            }
            actions={
                <Link href={APP_ROUTES.bookFacts(workspaceSlug, book.id)} className={buttonVariants({ variant: 'secondary' })}>
                    {t('factsLink')}
                </Link>
            }
        >
            <div className="space-y-section">
                <Card className="space-y-tight p-default" aria-labelledby="continuity-nightly-title">
                    <h2 id="continuity-nightly-title" className="text-sm font-semibold text-content-emphasis">
                        {t('nightly.title')}
                    </h2>
                    <p className="text-sm text-content-muted" data-testid="continuity-nightly">
                        {nightly.lastRunAt
                            ? t('nightly.lastRun', { when: new Date(nightly.lastRunAt).toLocaleString(), outcome: nightlyOutcomeText(nightly) })
                            : t('nightly.never')}
                    </p>
                    {nightly.lastRunAt ? (
                        <p className="text-sm text-content-muted">{t('nightly.covered', { covered: nightly.subjectsCovered, remaining: nightly.subjectsRemaining, facts: nightly.factsRead })}</p>
                    ) : null}
                    {nightly.passUnderWay ? <p className="text-sm text-content-muted">{t('nightly.passUnderWay')}</p> : null}
                    {nightly.factsCut ? (
                        <p className="text-sm text-content-muted" data-testid="continuity-nightly-cut">
                            {t('nightly.factsCut', { read: nightly.factsRead, total: page.liveFacts })}
                        </p>
                    ) : null}
                    {nightly.parkedSubjects > 0 ? (
                        <p className="text-sm text-content-muted" data-testid="continuity-nightly-parked">
                            {t('nightly.parked', { count: nightly.parkedSubjects })}
                        </p>
                    ) : null}
                </Card>

                <section className="space-y-default" aria-labelledby="continuity-contradictions-title" id="continuity-contradictions">
                    <div className="flex flex-wrap items-baseline justify-between gap-tight">
                        <h2 id="continuity-contradictions-title" className="text-base font-semibold text-content-emphasis">
                            {t('contradictions.title')}
                        </h2>
                        <span className="text-sm text-content-muted">{t('contradictions.count', { count: page.contradictions.pending })}</span>
                    </div>
                    {!page.assessed ? (
                        <EmptyState title={t('status.notAssessed')} description={t('status.notAssessedHelp')} />
                    ) : page.contradictions.items.length === 0 ? (
                        <p className="text-sm text-content-muted">{t('contradictions.none')}</p>
                    ) : (
                        page.contradictions.items.map((p) => (
                            <ContradictionCard key={p.id} proposal={p} canEdit={canEdit} onDecide={(pp, d, ex) => run(() => continuityApi.decideContradiction(workspaceSlug, book.id, pp.id, d, ex), t('contradictions.decided'))} />
                        ))
                    )}
                    {page.contradictions.truncated ? <p className="text-sm text-content-muted">{t('truncated', { shown: page.contradictions.items.length })}</p> : null}
                </section>

                {page.noLongerStated.items.length > 0 ? (
                    <section className="space-y-default" aria-labelledby="continuity-gone-title">
                        <h2 id="continuity-gone-title" className="text-base font-semibold text-content-emphasis">
                            {t('contradictions.noLongerStatedTitle')}
                        </h2>
                        {page.noLongerStated.items.map((p) => (
                            <ContradictionCard key={p.id} proposal={p} canEdit={canEdit} onDecide={(pp, d, ex) => run(() => continuityApi.decideContradiction(workspaceSlug, book.id, pp.id, d, ex), t('contradictions.decided'))} />
                        ))}
                    </section>
                ) : null}

                <section className="space-y-default" aria-labelledby="continuity-threads-title" id="continuity-threads">
                    <div className="flex flex-wrap items-center justify-between gap-tight">
                        <h2 id="continuity-threads-title" className="text-base font-semibold text-content-emphasis">
                            {t('threads.title')}
                        </h2>
                        {canEdit ? (
                            <Button type="button" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} id="thread-add">
                                {t('threads.add')}
                            </Button>
                        ) : null}
                    </div>
                    {page.threadProposals.items.length > 0 ? (
                        <div className="space-y-default" aria-label={t('threadProposals.title')}>
                            <h3 className="text-sm font-semibold text-content-emphasis">{t('threadProposals.title')}</h3>
                            <p className="text-sm text-content-muted">{t('threadProposals.help')}</p>
                            {page.threadProposals.items.map((p) => (
                                <ThreadProposalCard key={p.id} proposal={p} canEdit={canEdit} onDecide={(pp, d) => void run(() => continuityApi.decideThreadProposal(workspaceSlug, book.id, pp.id, d), d === 'ACCEPT' ? t('threadProposals.accepted') : t('threadProposals.rejected'))} />
                            ))}
                        </div>
                    ) : null}
                    {THREAD_KINDS.map((kind) => {
                        const list = threadsByKind.get(kind) ?? [];
                        const contradictionsOpen = kind === 'OPEN_QUESTION' ? page.contradictions.pending : 0;
                        const later = kind === 'OPEN_QUESTION' ? page.decideLater.items : [];
                        return (
                            <Card key={kind} className="space-y-tight p-default" aria-labelledby={`threads-${kind}`}>
                                <h3 id={`threads-${kind}`} className="text-sm font-semibold text-content-emphasis">
                                    {t(`threads.group.${kind}`)}
                                </h3>
                                {list.length === 0 && later.length === 0 && contradictionsOpen === 0 ? <p className="text-sm text-content-muted">{t('threads.none')}</p> : null}
                                {list.length > 0 ? (
                                    <ul className="divide-y divide-[var(--border-subtle)]">
                                        {list.map((th) => (
                                            <ThreadRow
                                                key={th.id}
                                                thread={th}
                                                canEdit={canEdit}
                                                onState={(x, state) => void run(() => continuityApi.updateThread(workspaceSlug, book.id, x.id, { baseVersion: x.version, state }), t('threads.saved'))}
                                                onEdit={setEditing}
                                                onRemove={removeThread}
                                            />
                                        ))}
                                    </ul>
                                ) : null}
                                {later.length > 0 ? (
                                    <ul className="divide-y divide-[var(--border-subtle)]" aria-label={t('decideLater.title')}>
                                        {later.map((d) => (
                                            <li key={d.answerId} className="space-y-tight py-default" data-testid="continuity-decide-later">
                                                <p className="text-sm text-content-emphasis">{d.question}</p>
                                                <p className="text-xs text-content-muted">
                                                    {d.pair ? t('decideLater.fromPair', { first: d.elementName ?? '', second: d.pair.elementName ?? '' }) : t('decideLater.from', { element: d.elementName ?? '' })}
                                                </p>
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}
                                {contradictionsOpen > 0 ? <p className="text-sm text-content-muted">{t('decideLater.contradictions', { count: contradictionsOpen })}</p> : null}
                            </Card>
                        );
                    })}
                    {page.threads.truncated ? <p className="text-sm text-content-muted">{t('truncated', { shown: page.threads.items.length })}</p> : null}
                </section>

                <section className="space-y-default" aria-labelledby="continuity-stale-title" id="continuity-stale">
                    <h2 id="continuity-stale-title" className="text-base font-semibold text-content-emphasis">
                        {t('stale.title')}
                    </h2>
                    <p className="text-sm text-content-muted">{t('stale.help')}</p>
                    {page.stale.items.length === 0 ? (
                        <p className="text-sm text-content-muted">{t('stale.none')}</p>
                    ) : (
                        <ul className="divide-y divide-[var(--border-subtle)]">
                            {page.stale.items.map((f) => (
                                <StaleRow key={f.id} workspaceSlug={workspaceSlug} bookId={book.id} flag={f} canEdit={canEdit} onDismiss={(x) => void run(() => continuityApi.dismissStale(workspaceSlug, book.id, x.id), t('stale.dismissed'))} />
                            ))}
                        </ul>
                    )}
                </section>
            </div>
            {adding ? <ThreadModal open={adding} setOpen={setAdding} initial={null} onSave={(d) => run(() => continuityApi.createThread(workspaceSlug, book.id, d), t('threads.saved'))} /> : null}
            {editing ? (
                <ThreadModal
                    open={editing !== null}
                    setOpen={(v) => (v ? undefined : setEditing(null))}
                    initial={editing}
                    onSave={(d) => run(() => continuityApi.updateThread(workspaceSlug, book.id, editing.id, { baseVersion: editing.version, title: d.title, note: d.note }), t('threads.saved'))}
                />
            ) : null}
        </EntityDetailLayout>
    );
}
