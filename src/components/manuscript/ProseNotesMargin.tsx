'use client';

/**
 * The scene editor's MARGIN (Phase 5.2, D34): the prose checks' notes beside
 * the text they are about. Each note is a BUTTON in a list, in text order,
 * aligned on wide screens to its text's line (the editor reports each note's
 * top) and stacked below the text on narrow ones; Tab moves through them and
 * Enter opens one. An open note says what the check found, and offers:
 *
 *   Dismiss            this note (it stays dismissed while its sentence is
 *                      unchanged; a changed sentence raises it again)
 *   Turn rule off      for the whole book (the settings page turns it back on)
 *   Accept / Reject    a deterministic suggestion (a deletion, the style
 *                      sheet's own swap, a spelling variant), drawn in the text
 *                      as a suggestion while the note is open; Accept edits the
 *                      text in the editor (autosaved like typing), Reject
 *                      dismisses the note. Nothing changes unless the author
 *                      accepts (D34 item 4).
 *
 * The status line never reads a scene that was not checked as "no notes"
 * (rule 6); a count is announced politely as notes arrive. A reader sees the
 * notes and none of the actions.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, EyeOff, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { PROSE_RULES, type ProseFindingView, type ProseRuleId, type SceneProseChecksView } from '@/lib/prose-checks/vocabulary';
import type { ScheduleState } from './use-prose-notes';

/** A collapsed note's height on the wide layout, and the gap kept between notes. */
const NOTE_HEIGHT = 32;
const NOTE_GAP = 4;

export interface ProseNotesMarginProps {
    view: SceneProseChecksView | null;
    /** The findings the editor placed, in text order. */
    placedIds: readonly string[];
    /** Findings the editor could not place (its text moved under them). */
    unplaced: number;
    /** Each placed note's top, below the editor's top. */
    layout: Readonly<Record<string, number>>;
    activeId: string | null;
    canEdit: boolean;
    loadError: boolean;
    scheduled: ScheduleState;
    onActivate: (id: string | null) => void;
    onDismiss: (finding: ProseFindingView) => void;
    onRuleOff: (finding: ProseFindingView) => void;
    onAccept: (finding: ProseFindingView) => void;
    onCheckNow: () => void;
}

/** The message key for a finding (a swap names its replacement). */
function messageKey(f: ProseFindingView): string {
    return f.ruleId === 'banned-words' && typeof f.params.replacement === 'string' ? `rules.${f.ruleId}.messageSwap` : `rules.${f.ruleId}.message`;
}

export function ProseNotesMargin({ view, placedIds, unplaced, layout, activeId, canEdit, loadError, scheduled, onActivate, onDismiss, onRuleOff, onAccept, onCheckNow }: ProseNotesMarginProps) {
    const t = useTranslations('manuscript.proseChecks');
    const [filter, setFilter] = useState<ComboboxOption | null>(null);
    const activeRef = useRef<HTMLDivElement | null>(null);
    const [activeHeight, setActiveHeight] = useState(NOTE_HEIGHT);

    const byId = useMemo(() => new Map((view?.findings ?? []).map((f) => [f.id, f] as const)), [view]);
    const placed = useMemo(() => placedIds.map((id) => byId.get(id)).filter((f): f is ProseFindingView => f !== undefined), [placedIds, byId]);
    const rulesPresent = useMemo(() => [...new Set(placed.map((f) => f.ruleId))], [placed]);
    const shown = filter ? placed.filter((f) => f.ruleId === filter.value) : placed;
    const filterOptions: ComboboxOption[] = rulesPresent.map((r) => ({ value: r, label: t(`rules.${r}.name`) }));

    useLayoutEffect(() => {
        setActiveHeight(activeRef.current ? activeRef.current.offsetHeight : NOTE_HEIGHT);
    }, [activeId, shown.length]);

    // Wide layout: each note at its text's top, pushed down past the one above it.
    const tops = new Map<string, number>();
    let floor = 0;
    for (const f of shown) {
        const top = Math.max(layout[f.id] ?? floor, floor);
        tops.set(f.id, top);
        floor = top + (f.id === activeId ? activeHeight : NOTE_HEIGHT) + NOTE_GAP;
    }

    const status = statusText(t, view, scheduled, loadError, placed.length);

    return (
        <aside className="space-y-tight" aria-label={t('marginLabel')} data-testid="prose-notes-margin">
            <div className="space-y-tight text-xs text-content-muted">
                <p role="status" aria-live="polite" data-testid="prose-notes-status" data-status={view?.status ?? 'LOADING'}>
                    {status}
                </p>
                {view?.readability ? (
                    <p data-testid="prose-readability">
                        {t('readability', { ease: Math.round(view.readability.readingEase), grade: view.readability.gradeLevel, band: t(`bands.${view.readability.band}`) })}
                    </p>
                ) : view?.status === 'CHECKED' ? (
                    <p data-testid="prose-readability">{t('readabilityNotAssessed')}</p>
                ) : null}
                {unplaced > 0 ? <p>{t('unplaced', { count: unplaced })}</p> : null}
                {view && view.rulesNotRun.length > 0 && view.status === 'CHECKED' ? <p>{view.styleSheetElementId ? t('rulesNotRunSheet', { count: view.rulesNotRun.length }) : t('noStyleSheet')}</p> : null}
                {canEdit && (view?.status === 'NOT_CHECKED' || view?.status === 'OUTDATED' || scheduled === 'UNAVAILABLE') ? (
                    <Button variant="secondary" size="sm" icon={<RefreshCw className="size-4" aria-hidden="true" />} onClick={onCheckNow} id="prose-check-now">
                        {t('checkNow')}
                    </Button>
                ) : null}
            </div>
            {rulesPresent.length > 1 ? (
                <FormField label={t('filter')}>
                    <Combobox options={filterOptions} selected={filter} setSelected={setFilter} placeholder={t('filterAll')} id="prose-notes-filter" matchTriggerWidth />
                </FormField>
            ) : null}
            <ol className="relative" style={{ minHeight: floor }} aria-label={t('listLabel', { count: shown.length })} data-testid="prose-notes-list">
                {shown.map((f, i) => {
                    const open = f.id === activeId;
                    const word = f.matched;
                    return (
                        <li
                            key={f.id}
                            // `top` only moves a positioned box: on a narrow screen the notes stack (static), on a wide one they align.
                            className="static mb-1 lg:absolute lg:inset-x-0 lg:mb-0"
                            style={{ top: tops.get(f.id) ?? 0 }}
                            data-testid="prose-note"
                            data-rule={f.ruleId}
                            data-note-id={f.id}
                        >
                            <div ref={open ? activeRef : undefined} className={`rounded-md border ${open ? 'border-border-emphasis bg-bg-elevated shadow-sm' : 'border-border-subtle bg-bg-default'}`}>
                                <button
                                    type="button"
                                    className="flex w-full items-center gap-tight px-2 py-1 text-left text-xs text-content-default"
                                    aria-expanded={open}
                                    onClick={() => onActivate(open ? null : f.id)}
                                    data-testid="prose-note-button"
                                >
                                    {/* The name is the visible words, with the note's place before them for a screen reader (label in name). */}
                                    <span className="sr-only">{t('notePosition', { n: i + 1, total: shown.length })} </span>
                                    <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${f.severity === 'WARNING' ? 'bg-[var(--content-warning)]' : 'bg-[var(--brand-default)]'}`} />
                                    <span className="truncate">{t(`rules.${f.ruleId}.name`)}</span>
                                    <span className="ml-auto truncate text-content-muted">{word}</span>
                                </button>
                                {open ? (
                                    <div className="space-y-tight border-t border-border-subtle px-2 py-2 text-xs" data-testid="prose-note-detail">
                                        <p className="text-content-default">{t(messageKey(f), f.params)}</p>
                                        {f.suggestion ? (
                                            <p className="text-content-muted" data-testid="prose-suggestion">
                                                {f.suggestion.replacement === '' ? t('suggestDelete', { text: word }) : t('suggestReplace', { text: word, replacement: f.suggestion.replacement })}
                                            </p>
                                        ) : null}
                                        {canEdit ? (
                                            <div className="flex flex-wrap gap-tight">
                                                {f.suggestion ? (
                                                    <>
                                                        <Button variant="primary" size="sm" icon={<Check className="size-4" aria-hidden="true" />} onClick={() => onAccept(f)} id={`prose-accept-${f.id}`} data-testid="prose-accept">
                                                            {t('accept')}
                                                        </Button>
                                                        <Button variant="secondary" size="sm" icon={<X className="size-4" aria-hidden="true" />} onClick={() => onDismiss(f)} data-testid="prose-reject">
                                                            {t('reject')}
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <Button variant="secondary" size="sm" icon={<X className="size-4" aria-hidden="true" />} onClick={() => onDismiss(f)} data-testid="prose-dismiss">
                                                        {t('dismiss')}
                                                    </Button>
                                                )}
                                                {PROSE_RULES[f.ruleId as ProseRuleId].defaultOff ? null : (
                                                    <Button variant="secondary" size="sm" icon={<EyeOff className="size-4" aria-hidden="true" />} onClick={() => onRuleOff(f)} data-testid="prose-rule-off">
                                                        {t('ruleOff')}
                                                    </Button>
                                                )}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                        </li>
                    );
                })}
            </ol>
        </aside>
    );
}

function statusText(t: ReturnType<typeof useTranslations>, view: SceneProseChecksView | null, scheduled: ScheduleState, loadError: boolean, shown: number): string {
    if (loadError && !view) return t('status.loadError');
    if (scheduled === 'OFF') return t('status.off');
    if (scheduled === 'UNAVAILABLE') return t('status.unavailable');
    if (!view) return t('status.loading');
    switch (view.status) {
        case 'NOT_CHECKED':
            return scheduled === 'SCHEDULED' ? t('status.checking') : t('status.notChecked');
        case 'PENDING':
            return t('status.checking');
        case 'OUTDATED':
            return t('status.outdated', { count: shown });
        default:
            return view.textCut ? t('status.checkedCut', { count: shown, words: view.wordsChecked }) : t('status.checked', { count: shown });
    }
}
