'use client';

/**
 * "Draft vs bible" on the Continuity page (Phase 5.3, D35). What the nightly reading of the manuscript found:
 *
 *   • whether it has read anything (rule 6: a manuscript never read reads "not read yet", never "no mismatches"), how
 *     many scenes wait, and its last night;
 *   • each mismatch between a scene's sentence and the bible, citing both, with the author's three choices — Fix the
 *     draft (I will), Update the bible (the entry's field opened PREFILLED with the draft's value; nothing is saved
 *     until the author saves it), Both are true (say how);
 *   • the threads a scene was read to plant or pay off, each citing its sentence, to confirm or reject;
 *   • D35 addendum C: "Recently resolved" — mismatches that settled by themselves in the last 30 days (the scene no
 *     longer says it, or the bible entry's fact went), each saying what changed; no notification is sent. An empty
 *     list says only that nothing settled lately, never that the draft agrees with the bible (rule 6).
 *
 * A mismatch the nightly deep check found (addendum A: the author let it read the draft) says so.
 *
 * `canEdit` is `bible.edit`, passed down; a reader reads. Every text renders as text. Refusals are worded from their
 * `details.reason`.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { FieldEditor } from '@/components/bible/FieldEditor';
import { APP_ROUTES } from '@/lib/app-routes';
import type { FieldValue } from '@/lib/bible/field-values';
import { draftApi } from '@/lib/draft-facts/api-client';
import type { DraftMismatchView, DraftReadingView, DraftUpdatePrefillView, SceneLinkView } from '@/lib/draft-facts/vocabulary';

export interface DraftAgainstBibleProps {
    workspaceSlug: string;
    bookId: string;
    canEdit: boolean;
    draft: {
        reading: DraftReadingView;
        mismatches: { items: DraftMismatchView[]; open: number; truncated: boolean };
        linkProposals: { items: SceneLinkView[]; pending: number; truncated: boolean };
        /** D35 addendum C: mismatches that settled by themselves lately (the database's clock), newest first. */
        recentlyResolved: { items: DraftMismatchView[]; days: number; truncated: boolean };
    };
    /** Runs a decision, toasts `done` (or the refusal) and reads the page again; true when it went through. */
    run: (work: () => Promise<unknown>, done: string) => Promise<boolean>;
    /** A refusal in words (its `details.reason`). */
    reasonText: (err: unknown) => string;
}

function SceneRef({ workspaceSlug, bookId, sceneId, title }: { workspaceSlug: string; bookId: string; sceneId: string; title: string | null }) {
    const t = useTranslations('continuity.draft');
    return (
        <Link href={APP_ROUTES.scene(workspaceSlug, bookId, sceneId)} className="underline">
            {title ?? t('untitledScene')}
        </Link>
    );
}

function UpdateBibleSheet({ workspaceSlug, bookId, prefill, onClose, run }: { workspaceSlug: string; bookId: string; prefill: DraftUpdatePrefillView; onClose: () => void; run: DraftAgainstBibleProps['run'] }) {
    const t = useTranslations('continuity.draft');
    const [value, setValue] = useState<FieldValue | null>(prefill.prefill as FieldValue | null);
    const [saving, setSaving] = useState(false);
    return (
        <Sheet open onOpenChange={(open) => (open ? undefined : onClose())} size="md" title={t('updateTitle', { element: prefill.elementName })}>
            <Sheet.Body className="space-y-default" data-testid="draft-update-sheet">
                <p className="text-sm text-content-muted">{t(`prefill.${prefill.prefillBasis}`)}</p>
                <div className="space-y-tight">
                    <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('draftSays')}</p>
                    <blockquote className="border-l-2 border-border-subtle pl-default text-sm text-content-default">{prefill.draftQuote}</blockquote>
                    <p className="text-xs text-content-muted">
                        <SceneRef workspaceSlug={workspaceSlug} bookId={bookId} sceneId={prefill.sceneId} title={prefill.sceneTitle} />
                    </p>
                </div>
                <FieldEditor def={prefill.field} value={value} onChange={setValue} readOnly={false} />
                <p className="text-xs text-content-muted">{t('updateHelp')}</p>
                <div className="flex flex-wrap gap-tight">
                    <Button
                        type="button"
                        variant="primary"
                        loading={saving}
                        id="draft-update-save"
                        onClick={async () => {
                            setSaving(true);
                            try {
                                if (await run(() => draftApi.saveUpdate(workspaceSlug, bookId, prefill.proposalId, prefill.baseVersion, value), t('updated'))) onClose();
                            } finally {
                                setSaving(false);
                            }
                        }}
                    >
                        {t('saveUpdate')}
                    </Button>
                    <Button type="button" variant="secondary" onClick={onClose}>
                        {t('cancel')}
                    </Button>
                </div>
            </Sheet.Body>
        </Sheet>
    );
}

function MismatchCard({ workspaceSlug, bookId, m, canEdit, run, onUpdate }: { workspaceSlug: string; bookId: string; m: DraftMismatchView; canEdit: boolean; run: DraftAgainstBibleProps['run']; onUpdate: (m: DraftMismatchView) => void }) {
    const t = useTranslations('continuity.draft');
    const tk = useTranslations('continuity.contradictions');
    const [explaining, setExplaining] = useState(false);
    const [explanation, setExplanation] = useState('');
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const decide = async (decision: 'FIX_DRAFT' | 'BOTH_TRUE', text?: string) => {
        setBusy(true);
        try {
            return await run(() => draftApi.decideMismatch(workspaceSlug, bookId, m.id, decision, text), t('decided'));
        } finally {
            setBusy(false);
        }
    };
    const heading = tk.has(`kind.${m.kind}`) ? tk(`kind.${m.kind}`) : tk('kind.OTHER');
    return (
        <Card className="space-y-default p-default" data-testid="draft-mismatch" data-status={m.status} aria-label={heading}>
            <div className="flex flex-wrap items-baseline justify-between gap-tight">
                <h3 className="text-sm font-semibold text-content-emphasis">{heading}</h3>
                <span className="flex flex-wrap items-center gap-tight">
                    {m.foundBy === 'DEEP_CHECK' ? (
                        <span className="text-xs text-content-muted" data-testid="draft-found-by-deep">
                            {t('foundByDeep')}
                        </span>
                    ) : null}
                    <StatusBadge variant={m.status === 'PENDING' ? 'warning' : 'info'}>{t(`status.${m.status}`)}</StatusBadge>
                </span>
            </div>
            <div className="grid gap-default md:grid-cols-2">
                <div className="space-y-tight">
                    <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('draftSays')}</p>
                    <blockquote className="border-l-2 border-border-subtle pl-default text-sm text-content-default">{m.draft.quote}</blockquote>
                    <p className="text-xs text-content-muted">
                        <SceneRef workspaceSlug={workspaceSlug} bookId={bookId} sceneId={m.sceneId} title={m.sceneTitle} />
                        {m.draft.live ? '' : ` · ${t('rewordedSince')}`}
                    </p>
                </div>
                <div className="space-y-tight">
                    <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('bibleSays')}</p>
                    <blockquote className="border-l-2 border-border-subtle pl-default text-sm text-content-default">{m.bible.quote}</blockquote>
                    <p className="text-xs text-content-muted">
                        {m.bible.elementId && m.bible.elementName ? (
                            <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, m.bible.elementId)} className="underline">
                                {m.bible.versionNumber !== null ? t('bibleOrigin', { element: m.bible.elementName, version: m.bible.versionNumber }) : m.bible.elementName}
                            </Link>
                        ) : (
                            t('bibleOriginUnknown')
                        )}
                    </p>
                </div>
            </div>
            {canEdit && m.status === 'PENDING' ? (
                <div className="flex flex-wrap gap-tight">
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => void decide('FIX_DRAFT')} data-testid="draft-fix">
                        {t('fixDraft')}
                    </Button>
                    {m.canUpdateBible ? (
                        <Button type="button" variant="secondary" disabled={busy} onClick={() => onUpdate(m)} data-testid="draft-update-bible">
                            {t('updateBible')}
                        </Button>
                    ) : null}
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => setExplaining(true)} data-testid="draft-both-true">
                        {t('bothTrue')}
                    </Button>
                </div>
            ) : null}
            {canEdit && m.status === 'FIX_PENDING' ? <p className="text-xs text-content-muted">{t('fixPendingHelp')}</p> : null}
            <Modal showModal={explaining} setShowModal={setExplaining} title={t('explainTitle')}>
                <Modal.Form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        setTouched(true);
                        if (explanation.trim() === '') return;
                        if (await decide('BOTH_TRUE', explanation)) setExplaining(false);
                    }}
                >
                    <Modal.Header title={t('explainTitle')} description={t('explainHelp')} />
                    <Modal.Body className="space-y-default">
                        <FormField label={t('explanation')} required error={touched && explanation.trim() === '' ? t('explanationRequired') : undefined}>
                            <Textarea id="draft-explanation" value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={4} />
                        </FormField>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button type="button" variant="secondary" onClick={() => setExplaining(false)}>
                            {t('cancel')}
                        </Button>
                        <Button type="submit" variant="primary" loading={busy} id="draft-explanation-submit">
                            {t('saveExplanation')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>
        </Card>
    );
}

/** D35 addendum C: one mismatch that settled by itself — the scene, the bible entry, and how it settled. */
function ResolvedRow({ workspaceSlug, bookId, m }: { workspaceSlug: string; bookId: string; m: DraftMismatchView }) {
    const t = useTranslations('continuity.draft');
    const tk = useTranslations('continuity.contradictions');
    const heading = tk.has(`kind.${m.kind}`) ? tk(`kind.${m.kind}`) : tk('kind.OTHER');
    return (
        <li className="space-y-tight py-default" data-testid="draft-resolved" data-reason={m.settled?.reason ?? ''}>
            <p className="text-sm text-content-emphasis">
                {heading} · <SceneRef workspaceSlug={workspaceSlug} bookId={bookId} sceneId={m.sceneId} title={m.sceneTitle} />
                {' · '}
                {m.bible.elementId && m.bible.elementName ? (
                    <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, m.bible.elementId)} className="underline">
                        {m.bible.elementName}
                    </Link>
                ) : (
                    t('bibleOriginUnknown')
                )}
            </p>
            <p className="text-xs text-content-muted">
                {t('resolved.was', { draft: m.draft.quote, bible: m.bible.quote })}
            </p>
            <p className="text-xs text-content-muted">
                {m.settled ? t(`resolved.how.${m.settled.reason}`) : null}
                {m.settled ? ` · ${new Date(m.settled.at).toLocaleDateString()}` : null}
            </p>
        </li>
    );
}

export function LinkProposalCard({ workspaceSlug, bookId, link, canEdit, run }: { workspaceSlug: string; bookId: string; link: SceneLinkView; canEdit: boolean; run: DraftAgainstBibleProps['run'] }) {
    const t = useTranslations('continuity.draft');
    const flagged = link.flags.includes('POSSIBLE_INSTRUCTION');
    return (
        <Card className="space-y-tight p-default" data-testid="draft-link-proposal" data-role={link.role}>
            <p className="text-sm text-content-emphasis">{t(`linkRole.${link.role}`, { title: link.threadTitle })}</p>
            <blockquote className="border-l-2 border-border-subtle pl-default text-sm text-content-default">{link.quote}</blockquote>
            <p className="text-xs text-content-muted">
                <SceneRef workspaceSlug={workspaceSlug} bookId={bookId} sceneId={link.sceneId} title={link.sceneTitle} />
            </p>
            {flagged ? <p className="text-xs text-content-error">{t('flagged')}</p> : null}
            {canEdit && link.status === 'PENDING' ? (
                <div className="flex flex-wrap gap-tight">
                    <Button type="button" size="sm" variant="primary" onClick={() => void run(() => draftApi.decideLink(workspaceSlug, bookId, link.id, 'CONFIRM'), t('linkConfirmed'))} data-testid="draft-link-confirm">
                        {t('confirm')}
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => void run(() => draftApi.decideLink(workspaceSlug, bookId, link.id, 'REJECT'), t('linkRejected'))} data-testid="draft-link-reject">
                        {t('reject')}
                    </Button>
                </div>
            ) : null}
        </Card>
    );
}

export function DraftAgainstBible({ workspaceSlug, bookId, canEdit, draft, run, reasonText }: DraftAgainstBibleProps) {
    const t = useTranslations('continuity.draft');
    const [prefill, setPrefill] = useState<DraftUpdatePrefillView | null>(null);
    const [opening, setOpening] = useState(false);
    const reading = draft.reading;
    const neverRead = reading.scenesRead === 0;
    const openUpdate = async (m: DraftMismatchView) => {
        setOpening(true);
        try {
            setPrefill((await draftApi.updatePrefill(workspaceSlug, bookId, m.id)).prefill);
        } catch (err) {
            toast.error(reasonText(err));
        } finally {
            setOpening(false);
        }
    };
    return (
        <section className="space-y-default" aria-labelledby="continuity-draft-title" id="continuity-draft" aria-busy={opening}>
            <div className="flex flex-wrap items-baseline justify-between gap-tight">
                <h2 id="continuity-draft-title" className="text-base font-semibold text-content-emphasis">
                    {t('title')}
                </h2>
                {/* Rule 6: a manuscript never read has no count of mismatches to give. */}
                {neverRead ? null : <span className="text-sm text-content-muted">{t('count', { count: draft.mismatches.open })}</span>}
            </div>
            <p className="text-sm text-content-muted" data-testid="draft-reading">
                {reading.scenesWithText === 0
                    ? t('reading.noText')
                    : neverRead
                      ? t('reading.notRead', { total: reading.scenesWithText })
                      : t('reading.read', { read: reading.scenesRead, total: reading.scenesWithText })}
                {reading.scenesWaiting > 0 ? ` ${t('reading.waiting', { count: reading.scenesWaiting })}` : ''}
                {reading.scenesPassedOver > 0 ? ` ${t('reading.passedOver', { count: reading.scenesPassedOver })}` : ''}
            </p>
            {reading.lastRunAt ? (
                <p className="text-xs text-content-muted">{t('reading.lastRun', { when: new Date(reading.lastRunAt).toLocaleString(), outcome: t.has(`outcome.${reading.lastOutcome}`) ? t(`outcome.${reading.lastOutcome}`) : (reading.lastOutcome ?? '') })}</p>
            ) : null}
            {neverRead ? (
                <EmptyState title={t('notReadTitle')} description={t('notReadHelp')} />
            ) : draft.mismatches.items.length === 0 ? (
                <p className="text-sm text-content-muted">{reading.scenesWaiting > 0 ? t('noneSoFar') : t('none')}</p>
            ) : (
                draft.mismatches.items.map((m) => <MismatchCard key={m.id} workspaceSlug={workspaceSlug} bookId={bookId} m={m} canEdit={canEdit} run={run} onUpdate={(x) => void openUpdate(x)} />)
            )}
            {draft.mismatches.truncated ? <p className="text-sm text-content-muted">{t('truncated', { shown: draft.mismatches.items.length })}</p> : null}
            {draft.linkProposals.items.length > 0 ? (
                <div className="space-y-default" aria-label={t('linksTitle')}>
                    <h3 className="text-sm font-semibold text-content-emphasis">{t('linksTitle')}</h3>
                    <p className="text-sm text-content-muted">{t('linksHelp')}</p>
                    {draft.linkProposals.items.map((l) => (
                        <LinkProposalCard key={l.id} workspaceSlug={workspaceSlug} bookId={bookId} link={l} canEdit={canEdit} run={run} />
                    ))}
                    {draft.linkProposals.truncated ? <p className="text-sm text-content-muted">{t('truncated', { shown: draft.linkProposals.items.length })}</p> : null}
                </div>
            ) : null}
            <section className="space-y-tight" aria-labelledby="continuity-draft-resolved-title" id="continuity-draft-resolved">
                <h3 id="continuity-draft-resolved-title" className="text-sm font-semibold text-content-emphasis">
                    {t('resolved.title')}
                </h3>
                <p className="text-sm text-content-muted">{t('resolved.help', { days: draft.recentlyResolved.days })}</p>
                {draft.recentlyResolved.items.length === 0 ? (
                    // Rule 6: nothing settled lately is all this says — open mismatches, if any, are listed above.
                    <p className="text-sm text-content-muted" data-testid="draft-resolved-none">
                        {t('resolved.none', { days: draft.recentlyResolved.days })}
                    </p>
                ) : (
                    <ul className="divide-y divide-[var(--border-subtle)]">
                        {draft.recentlyResolved.items.map((m) => (
                            <ResolvedRow key={m.id} workspaceSlug={workspaceSlug} bookId={bookId} m={m} />
                        ))}
                    </ul>
                )}
                {draft.recentlyResolved.truncated ? <p className="text-sm text-content-muted">{t('resolved.truncated', { shown: draft.recentlyResolved.items.length })}</p> : null}
            </section>
            {prefill ? <UpdateBibleSheet workspaceSlug={workspaceSlug} bookId={bookId} prefill={prefill} onClose={() => setPrefill(null)} run={run} /> : null}
        </section>
    );
}
