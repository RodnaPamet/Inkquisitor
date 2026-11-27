'use client';

/**
 * "Draft vs bible" for one scene, in the scene editor's panel (Phase 5.3, D35). What the nightly reading found in THIS
 * scene: the sentences at odds with the bible (each marked in the text as a draft note when the editor's text still
 * reads the quoted sentence — a stale offset is never placed), and the threads the scene was read to plant or pay off.
 *
 *   not read     a scene whose current text was not read yet says so (rule 6), never "no mismatches"
 *   a mismatch   the scene's sentence and the bible's, with "Fix the draft" here; the other two choices (update the
 *                bible, both true) are the Continuity page's, which this links to
 *   a link       a pending one is confirmed or rejected here; a confirmed one is shown
 *
 * Nothing here edits the text: fixing the draft is the author's own typing (D3).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { APP_ROUTES } from '@/lib/app-routes';
import type { SceneDraftNotesView } from '@/lib/draft-facts/api-client';
import { DRAFT_NOTE_PREFIX, type DraftMismatchView, type SceneLinkView } from '@/lib/draft-facts/vocabulary';

export interface SceneDraftPanelProps {
    workspaceSlug: string;
    bookId: string;
    canEdit: boolean;
    notes: SceneDraftNotesView | null;
    loadError: boolean;
    /** The draft notes the editor placed (their editor ids). */
    placedIds: readonly string[];
    activeId: string | null;
    onReveal: (editorId: string) => void;
    onFixDraft: (m: DraftMismatchView) => void;
    onLink: (l: SceneLinkView, decision: 'CONFIRM' | 'REJECT') => void;
}

export function SceneDraftPanel({ workspaceSlug, bookId, canEdit, notes, loadError, placedIds, activeId, onReveal, onFixDraft, onLink }: SceneDraftPanelProps) {
    const t = useTranslations('manuscript.draft');
    const placed = new Set(placedIds);
    const status = loadError && !notes ? t('loadError') : !notes ? t('loading') : notes.passedOver ? t('passedOver') : !notes.everRead ? t('notRead') : !notes.readAtCurrentText ? t('readEarlier') : notes.mismatches.length === 0 ? t('none') : t('count', { count: notes.mismatches.length });
    return (
        <Card className="space-y-default p-4" data-testid="scene-draft">
            <p role="status" className="text-sm text-content-muted" data-testid="scene-draft-status">
                {status}
            </p>
            {notes && notes.mismatches.length > 0 ? (
                <ul className="space-y-default" aria-label={t('mismatchesLabel')}>
                    {notes.mismatches.map((m) => {
                        const editorId = `${DRAFT_NOTE_PREFIX}${m.id}`;
                        const isPlaced = placed.has(editorId);
                        return (
                            <li key={m.id} className={`space-y-tight rounded-md border p-2 ${activeId === editorId ? 'border-border-emphasis' : 'border-border-subtle'}`} data-testid="scene-draft-mismatch" data-placed={isPlaced ? 'true' : 'false'}>
                                <div className="flex flex-wrap items-center justify-between gap-tight">
                                    <StatusBadge variant={m.status === 'PENDING' ? 'warning' : 'info'}>{t(`status.${m.status}`)}</StatusBadge>
                                    {isPlaced ? (
                                        <Button variant="secondary" size="sm" onClick={() => onReveal(editorId)} data-testid="scene-draft-reveal">
                                            {t('show')}
                                        </Button>
                                    ) : (
                                        <span className="text-xs text-content-muted">{t('notPlaced')}</span>
                                    )}
                                </div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('draftSays')}</p>
                                <blockquote className="border-l-2 border-border-subtle pl-default text-sm text-content-default">{m.draft.quote}</blockquote>
                                <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('bibleSays')}</p>
                                <blockquote className="border-l-2 border-border-subtle pl-default text-sm text-content-default">{m.bible.quote}</blockquote>
                                {m.bible.elementId && m.bible.elementName ? (
                                    <p className="text-xs text-content-muted">
                                        <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, m.bible.elementId)} className="underline">
                                            {m.bible.elementName}
                                        </Link>
                                    </p>
                                ) : null}
                                {canEdit && m.status === 'PENDING' ? (
                                    <div className="flex flex-wrap gap-tight">
                                        <Button variant="secondary" size="sm" onClick={() => onFixDraft(m)} data-testid="scene-draft-fix">
                                            {t('fixDraft')}
                                        </Button>
                                        <Link href={`${APP_ROUTES.continuity(workspaceSlug, bookId)}#continuity-draft`} className="text-xs text-content-brand underline">
                                            {t('otherChoices')}
                                        </Link>
                                    </div>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            ) : null}
            {notes && notes.links.length > 0 ? (
                <div className="space-y-tight">
                    <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('linksTitle')}</p>
                    <ul className="space-y-tight" aria-label={t('linksTitle')}>
                        {notes.links.map((l) => (
                            <li key={l.id} className="space-y-tight" data-testid="scene-draft-link" data-status={l.status}>
                                <p className="text-sm text-content-default">{t(`linkRole.${l.role}`, { title: l.threadTitle })}</p>
                                {l.status === 'PENDING' ? (
                                    <>
                                        <blockquote className="border-l-2 border-border-subtle pl-default text-xs text-content-muted">{l.quote}</blockquote>
                                        {canEdit ? (
                                            <div className="flex flex-wrap gap-tight">
                                                <Button variant="primary" size="sm" onClick={() => onLink(l, 'CONFIRM')} data-testid="scene-draft-link-confirm">
                                                    {t('confirm')}
                                                </Button>
                                                <Button variant="secondary" size="sm" onClick={() => onLink(l, 'REJECT')} data-testid="scene-draft-link-reject">
                                                    {t('reject')}
                                                </Button>
                                            </div>
                                        ) : (
                                            <p className="text-xs text-content-muted">{t('proposed')}</p>
                                        )}
                                    </>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            {notes?.truncated ? <p className="text-xs text-content-muted">{t('truncated')}</p> : null}
        </Card>
    );
}
