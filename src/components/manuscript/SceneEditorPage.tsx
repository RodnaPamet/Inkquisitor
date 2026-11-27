'use client';

/**
 * A scene's editor (Phase 5.1, D33): a distraction-free page for the prose.
 *
 *   the text      `SceneTextEditor` (TipTap, `@` mentions), autosaved by
 *                 `useSceneAutosave`: debounced, one request at a time, a
 *                 failed save kept, a conflict held for the author to reload or
 *                 keep theirs; a version written when the author pauses or leaves
 *   word counts   the scene's, its chapter's and the manuscript's, live as the
 *                 author types (the stored counts plus this scene's change)
 *   session goal  set when starting to write; progress over the tab's session
 *                 (`useSessionGoal`, numbers in sessionStorage, nothing stored)
 *   the panel     the scene's details (title, point of view, setting, story
 *                 time, plot beats), its linked elements with their summaries
 *                 (mentions and explicit links), its note, and its history
 *   focus         hides the panel and the header: the text alone
 *   prose notes   the style checks' margin (5.2, D34): notes beside the text,
 *                 dismissed or acted on by the author; a suggestion is applied
 *                 only when the author accepts it, as an edit of their own that
 *                 the autosave sends like any keystroke
 *   card          5.3 (D35): the scene's card (goal, conflict, outcome, what
 *                 changed), edited by the author or filled by "Grill me on this
 *                 scene" through accepted proposals — never the prose
 *   draft notes   5.3 (D35): what the nightly reading found at odds with the
 *                 bible, marked in the text as their own kind of note where the
 *                 text still reads the quoted sentence, and the threads the
 *                 scene plants or pays off
 *
 * A reader reads the text and the panel as text: no control is offered.
 * Nothing here calls a model, and nothing writes the text but the autosave and
 * a restore (D3).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ChevronLeft, ChevronRight, Eye, EyeOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { APP_ROUTES } from '@/lib/app-routes';
import { bibleFetch, reasonOf } from '@/lib/bible/api-client';
import { BIBLE_KINDS } from '@/lib/bible/kinds';
import { MANUSCRIPT_API, type SceneTextResult, type SceneView } from '@/lib/manuscript/api-client';
import { ElementPicker } from './ElementPicker';
import { ProseNotesMargin } from './ProseNotesMargin';
import type { SceneEditorApi } from './SceneTextEditor';
import { useProseNotes } from './use-prose-notes';
import type { ProseFindingView } from '@/lib/prose-checks/vocabulary';
import { SceneHistoryPanel } from './SceneHistoryPanel';
import { SceneCardPanel } from './SceneCardPanel';
import { SceneDraftPanel } from './SceneDraftPanel';
import { useSceneDraftNotes } from './use-scene-draft-notes';
import { DRAFT_NOTE_PREFIX } from '@/lib/draft-facts/vocabulary';
import { useManuscriptReason } from './messages';
import { useSceneAutosave } from './use-scene-autosave';
import { SESSION_GOAL_MAX, useSessionGoal } from './use-session-goal';

const SceneTextEditor = dynamic(() => import('./SceneTextEditor'), {
    ssr: false,
    loading: () => <div className="min-h-[60vh]" aria-busy="true" />,
});

export interface SceneEditorPageProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    initial: SceneView;
    canEdit: boolean;
    kindLabels: Record<string, string>;
    /** Phase 5.H-a: open the text at a place (a word-search result's offsets), or null. */
    openAt?: { start: number; length: number } | null;
}

type PanelTab = 'details' | 'links' | 'note' | 'card' | 'draft' | 'history';
const PANEL_TABS: readonly PanelTab[] = ['details', 'links', 'note', 'card', 'draft', 'history'];

export function SceneEditorPage({ workspaceSlug, book, initial, canEdit, kindLabels, openAt = null }: SceneEditorPageProps) {
    const t = useTranslations('manuscript.editor');
    const tAi = useTranslations('aiUse');
    const reasonText = useManuscriptReason();
    const [scene, setScene] = useState<SceneView>(initial);
    const [editorKey, setEditorKey] = useState(0);
    const [editorHtml, setEditorHtml] = useState(initial.text);
    const [words, setWords] = useState(initial.wordCount);
    const [focus, setFocus] = useState(false);
    const [tab, setTab] = useState<PanelTab>('details');
    const [detailsError, setDetailsError] = useState<string | null>(null);
    const [savingDetails, setSavingDetails] = useState(false);
    const [title, setTitle] = useState(initial.title ?? '');
    const [storyTime, setStoryTime] = useState(initial.storyTime ?? '');
    const [note, setNote] = useState(initial.note ?? '');
    const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [goalInput, setGoalInput] = useState('');
    const kindLabel = useCallback((k: string) => kindLabels[k] ?? k, [kindLabels]);

    const refresh = useCallback(async () => {
        const { scene: fresh } = await bibleFetch<{ scene: SceneView }>(MANUSCRIPT_API.scene(workspaceSlug, book.id, initial.id));
        setScene(fresh);
        return fresh;
    }, [workspaceSlug, book.id, initial.id]);

    const onSaved = useCallback(
        (r: SceneTextResult) => {
            if (r.linksChanged || r.versionNumber !== null) void refresh().catch(() => undefined);
        },
        [refresh],
    );
    const autosave = useSceneAutosave({ workspaceSlug, bookId: book.id, sceneId: initial.id, enabled: canEdit, initialRevision: initial.revision, onSaved });
    const session = useSessionGoal(book.id, initial.id, initial.wordCount);

    // The prose notes (5.2, D34): read after each save, placed by the editor, acted on here.
    const notes = useProseNotes({ workspaceSlug, bookId: book.id, sceneId: initial.id, canEdit, revision: autosave.revision });
    const editorApi = useRef<SceneEditorApi | null>(null);
    const [placedIds, setPlacedIds] = useState<string[]>([]);
    const [unplaced, setUnplaced] = useState(0);
    const [layout, setLayout] = useState<Record<string, number>>({});
    const [activeNote, setActiveNote] = useState<string | null>(null);
    const [draftPlaced, setDraftPlaced] = useState<string[]>([]);
    const onApi = useCallback((api: SceneEditorApi | null) => {
        editorApi.current = api;
    }, []);
    const onNotesPlaced = useCallback((ids: string[], missed: number) => {
        setPlacedIds(ids);
        setUnplaced(missed);
        setActiveNote(null);
    }, []);
    const onNotesLayout = useCallback((l: Array<{ id: string; top: number }>) => {
        setLayout(Object.fromEntries(l.map((x) => [x.id, x.top])));
        // A note the text no longer holds (edited away) leaves the margin with it.
        const live = new Set(l.map((x) => x.id));
        const keep = (ids: string[]) => {
            const next = ids.filter((id) => live.has(id));
            return next.length === ids.length ? ids : next;
        };
        setPlacedIds(keep);
        // 5.3: a draft note whose sentence was edited away leaves the panel's "show" with it.
        setDraftPlaced(keep);
    }, []);
    const takeOff = useCallback((ids: readonly string[]) => {
        editorApi.current?.removeNotes(ids);
        setPlacedIds((prev) => prev.filter((id) => !ids.includes(id)));
        setActiveNote((a) => (a !== null && ids.includes(a) ? null : a));
    }, []);
    const dismissNote = useCallback(
        (f: ProseFindingView) => {
            takeOff([f.id]);
            void notes.dismiss(f.id);
        },
        [notes, takeOff],
    );
    const ruleOff = useCallback(
        (f: ProseFindingView) => {
            takeOff((notes.view?.findings ?? []).filter((x) => x.ruleId === f.ruleId).map((x) => x.id));
            void notes.turnRuleOff(f.ruleId);
        },
        [notes, takeOff],
    );
    const acceptNote = useCallback(
        (f: ProseFindingView) => {
            // The author's own edit, in the editor: its autosave sends it like any keystroke.
            if (editorApi.current?.acceptSuggestion(f.id)) {
                notes.forget(f.id);
                setActiveNote(null);
            }
        },
        [notes],
    );

    // The draft notes (5.3, D35): read when the page opens and after a decision; placed by the editor.
    const draft = useSceneDraftNotes({ workspaceSlug, bookId: book.id, sceneId: initial.id });
    const onDraftNotesPlaced = useCallback((ids: string[]) => setDraftPlaced(ids), []);
    const revealDraft = useCallback((id: string) => {
        setActiveNote(id);
        editorApi.current?.revealNote(id);
    }, []);
    const onNoteActivate = useCallback((id: string) => {
        setActiveNote(id);
        if (id.startsWith(DRAFT_NOTE_PREFIX)) setTab('draft');
    }, []);

    const onChange = useCallback(
        (html: string, count: number) => {
            autosave.edit(html);
            setWords(count);
            session.report(count);
        },
        [autosave, session],
    );

    const chapterWords = scene.chapterWords - initial.wordCount + words;
    const manuscriptWords = scene.manuscriptWords - initial.wordCount + words;

    async function reloadTheirs() {
        const fresh = await refresh();
        setEditorHtml(fresh.text);
        setEditorKey((k) => k + 1);
        setWords(fresh.wordCount);
        autosave.rebase(fresh.revision);
    }

    async function saveDetails(change: Record<string, unknown>) {
        setSavingDetails(true);
        setDetailsError(null);
        try {
            const result = await autosave.alongside((baseRevision) =>
                bibleFetch<{ scene: SceneView }>(MANUSCRIPT_API.scene(workspaceSlug, book.id, initial.id), { method: 'PATCH', body: { baseRevision, ...change } }).then((r) => ({ revision: r.scene.revision, scene: r.scene })),
            );
            setScene(result.scene);
        } catch (err) {
            setDetailsError(reasonText(reasonOf(err)));
        } finally {
            setSavingDetails(false);
        }
    }

    async function saveNote() {
        setNoteState('saving');
        try {
            const r = await bibleFetch<{ noteVersion: number; note: string | null }>(MANUSCRIPT_API.note(workspaceSlug, book.id, initial.id), {
                method: 'PUT',
                body: { note, baseNoteVersion: scene.noteVersion },
            });
            setScene((s) => ({ ...s, note: r.note, noteVersion: r.noteVersion }));
            setNote(r.note ?? '');
            setNoteState('saved');
        } catch {
            setNoteState('error');
        }
    }

    async function restore(n: number) {
        await autosave.flush();
        const r = await bibleFetch<SceneTextResult>(MANUSCRIPT_API.restore(workspaceSlug, book.id, initial.id, n), { method: 'POST', body: { baseRevision: autosave.revision } });
        const fresh = await refresh();
        setEditorHtml(fresh.text);
        setEditorKey((k) => k + 1);
        setWords(r.wordCount);
        autosave.rebase(r.revision);
    }

    const explicitIds = useMemo(() => new Set(scene.links.filter((l) => l.explicit).map((l) => l.elementId)), [scene.links]);
    const beatIds = useMemo(() => new Set(scene.beats.map((b) => b.id)), [scene.beats]);
    const goalPct = session.goal ? Math.min(100, Math.round((session.written / session.goal) * 100)) : null;
    const saveText =
        autosave.state === 'error' ? reasonText(autosave.errorReason) : autosave.state === 'conflict' ? t('save.conflict') : t(`save.${autosave.state}`);

    return (
        <div className="space-y-default" data-testid="scene-editor" data-focus={focus ? 'true' : 'false'}>
            {!focus ? (
                <div className="flex flex-wrap items-center justify-between gap-default">
                    <div className="flex min-w-0 flex-wrap items-center gap-tight">
                        <Link href={APP_ROUTES.manuscript(workspaceSlug, book.id)} className="inline-flex items-center gap-1 text-sm font-medium text-content-brand hover:underline" id="scene-back">
                            <ArrowLeft className="size-4" aria-hidden="true" />
                            {t('back')}
                        </Link>
                        <span className="text-sm text-content-muted">
                            {scene.chapterTitle ?? t('untitledChapter')} · {book.title}
                        </span>
                    </div>
                    <div className="flex items-center gap-tight">
                        {scene.previousSceneId ? (
                            <Link href={APP_ROUTES.scene(workspaceSlug, book.id, scene.previousSceneId)} className="inline-flex items-center gap-1 text-sm text-content-brand hover:underline" id="scene-previous">
                                <ChevronLeft className="size-4" aria-hidden="true" />
                                {t('previous')}
                            </Link>
                        ) : null}
                        {scene.nextSceneId ? (
                            <Link href={APP_ROUTES.scene(workspaceSlug, book.id, scene.nextSceneId)} className="inline-flex items-center gap-1 text-sm text-content-brand hover:underline" id="scene-next">
                                {t('next')}
                                <ChevronRight className="size-4" aria-hidden="true" />
                            </Link>
                        ) : null}
                    </div>
                </div>
            ) : null}

            <div className={focus ? 'mx-auto max-w-3xl' : 'grid gap-section lg:grid-cols-[minmax(0,1fr)_22rem]'}>
                <div className="min-w-0 space-y-default">
                    <h1 className="text-2xl font-semibold text-content-emphasis" data-testid="scene-title">
                        {scene.title ?? t('untitledScene')}
                    </h1>
                    {autosave.state === 'conflict' ? (
                        <div className="space-y-tight rounded-md border border-border-default bg-bg-warning p-3" role="alert" data-testid="scene-conflict">
                            <p className="text-sm text-content-default">{t('conflict')}</p>
                            <div className="flex flex-wrap gap-tight">
                                <Button variant="secondary" size="sm" onClick={() => void reloadTheirs()} id="scene-reload">
                                    {t('reloadTheirs')}
                                </Button>
                                <Button variant="primary" size="sm" onClick={() => autosave.keepMine()} id="scene-keep">
                                    {t('keepMine')}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                    <p className="text-xs text-content-muted" data-testid="scene-d3-line">
                        {tAi('editorLine')}
                    </p>
                    <Card className="p-6">
                        <div className="gap-default lg:grid lg:grid-cols-[minmax(0,1fr)_14rem]">
                            <SceneTextEditor
                                key={editorKey}
                                workspaceSlug={workspaceSlug}
                                bookId={book.id}
                                initialHtml={editorHtml}
                                openAt={editorKey === 0 ? openAt : null}
                                editable={canEdit}
                                onChange={onChange}
                                label={t('textLabel')}
                                kindLabel={kindLabel}
                                proseNotes={
                                    // Placed only while nothing typed is waiting to be saved: the stored text, which was checked, is the editor's.
                                    notes.view && (autosave.state === 'saved' || autosave.state === 'idle') ? { token: notes.token + editorKey * 100_000, findings: notes.view.findings } : null
                                }
                                draftNotes={
                                    draft.notes && (autosave.state === 'saved' || autosave.state === 'idle')
                                        ? { token: draft.token + editorKey * 100_000, notes: draft.notes.mismatches.map((m) => ({ id: m.id, start: m.draft.start, end: m.draft.end, quote: m.draft.quote })) }
                                        : null
                                }
                                onDraftNotesPlaced={onDraftNotesPlaced}
                                activeNoteId={activeNote}
                                onNotesPlaced={onNotesPlaced}
                                onNotesLayout={onNotesLayout}
                                onNoteActivate={onNoteActivate}
                                onApi={onApi}
                            />
                            <div className="mt-section lg:mt-0">
                                <ProseNotesMargin
                                    view={notes.view}
                                    placedIds={placedIds}
                                    unplaced={unplaced}
                                    layout={layout}
                                    activeId={activeNote}
                                    canEdit={canEdit}
                                    loadError={notes.loadError}
                                    scheduled={notes.scheduled}
                                    onActivate={(id) => {
                                        setActiveNote(id);
                                        if (id) editorApi.current?.revealNote(id);
                                    }}
                                    onDismiss={dismissNote}
                                    onRuleOff={ruleOff}
                                    onAccept={acceptNote}
                                    onCheckNow={() => void notes.checkNow()}
                                />
                            </div>
                        </div>
                    </Card>
                    <div className="flex flex-wrap items-center justify-between gap-default text-sm text-content-muted" data-testid="scene-status">
                        <p aria-live="polite">
                            <span data-testid="scene-words">{t('sceneWords', { count: words })}</span> · <span data-testid="chapter-words">{t('chapterWords', { count: chapterWords })}</span> ·{' '}
                            <span data-testid="manuscript-words">{t('manuscriptWords', { count: manuscriptWords })}</span>
                        </p>
                        <div className="flex items-center gap-default">
                            {canEdit ? (
                                <span role="status" data-testid="scene-save" data-state={autosave.state}>
                                    {saveText}
                                </span>
                            ) : null}
                            {canEdit && autosave.state === 'error' ? (
                                <Button variant="secondary" size="sm" onClick={() => void autosave.flush()}>
                                    {t('retry')}
                                </Button>
                            ) : null}
                            <Button
                                variant="secondary"
                                size="sm"
                                icon={focus ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                                onClick={() => setFocus((f) => !f)}
                                aria-pressed={focus}
                                id="scene-focus"
                            >
                                {focus ? t('leaveFocus') : t('focus')}
                            </Button>
                        </div>
                    </div>
                    {canEdit ? (
                        <div className="flex flex-wrap items-end gap-default" data-testid="session-goal">
                            {session.goal ? (
                                <div className="min-w-[14rem] flex-1 space-y-tight">
                                    <p className="text-sm text-content-default">{t('goalProgress', { written: session.written, goal: session.goal })}</p>
                                    <div
                                        className="h-2 w-full overflow-hidden rounded-full bg-bg-muted"
                                        role="progressbar"
                                        aria-label={t('goalLabel')}
                                        aria-valuemin={0}
                                        aria-valuemax={session.goal}
                                        aria-valuenow={Math.min(session.written, session.goal)}
                                    >
                                        <div className="h-full bg-[var(--brand-default)]" style={{ width: `${goalPct}%` }} />
                                    </div>
                                </div>
                            ) : null}
                            <form
                                className="flex items-end gap-tight"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    const n = Number.parseInt(goalInput, 10);
                                    session.setGoal(Number.isFinite(n) && n > 0 ? n : null);
                                    setGoalInput('');
                                }}
                            >
                                <FormField label={session.goal ? t('goalChange') : t('goalSet')}>
                                    <Input id="session-goal-input" inputMode="numeric" value={goalInput} onChange={(e) => setGoalInput(e.target.value.replace(/[^0-9]/g, '').slice(0, String(SESSION_GOAL_MAX).length))} placeholder={t('goalPlaceholder')} />
                                </FormField>
                                <Button type="submit" variant="secondary" size="sm" id="session-goal-save">
                                    {t('goalSave')}
                                </Button>
                                {session.goal ? (
                                    <Button type="button" variant="secondary" size="sm" icon={<X className="size-4" aria-hidden="true" />} onClick={() => session.setGoal(null)} aria-label={t('goalClear')} />
                                ) : null}
                            </form>
                        </div>
                    ) : null}
                </div>

                {!focus ? (
                    <aside className="space-y-default" aria-label={t('panel')} data-testid="scene-panel">
                        <ToggleGroup
                            ariaLabel={t('panel')}
                            options={PANEL_TABS.map((v) => ({ value: v, label: t(`tab.${v}`) }))}
                            selected={tab}
                            selectAction={(v) => setTab(v as PanelTab)}
                        />
                        {tab === 'card' ? <SceneCardPanel workspaceSlug={workspaceSlug} bookId={book.id} sceneId={initial.id} canEdit={canEdit} /> : null}
                        {tab === 'draft' ? (
                            <SceneDraftPanel
                                workspaceSlug={workspaceSlug}
                                bookId={book.id}
                                canEdit={canEdit}
                                notes={draft.notes}
                                loadError={draft.loadError}
                                placedIds={draftPlaced}
                                activeId={activeNote}
                                onReveal={revealDraft}
                                onFixDraft={(m) => void draft.fixDraft(m.id)}
                                onLink={(l, d) => void draft.decideLink(l.id, d)}
                            />
                        ) : null}
                        {tab === 'details' ? (
                            <Card className="space-y-default p-4" data-testid="scene-details">
                                {canEdit ? (
                                    <>
                                        <FormField label={t('titleField')}>
                                            <Input
                                                id="scene-title-input"
                                                value={title}
                                                onChange={(e) => setTitle(e.target.value)}
                                                onBlur={() => {
                                                    if ((title.trim() || null) !== scene.title) void saveDetails({ title: title.trim() || null });
                                                }}
                                            />
                                        </FormField>
                                        <FormField label={t('pov')}>
                                            <ElementPicker
                                                id="scene-pov"
                                                workspaceSlug={workspaceSlug}
                                                bookId={book.id}
                                                kinds={['CHARACTER']}
                                                selected={scene.pov}
                                                onSelect={(e) => void saveDetails({ povElementId: e?.id ?? null })}
                                                placeholder={t('povNone')}
                                                disabled={savingDetails}
                                            />
                                        </FormField>
                                        <FormField label={t('setting')}>
                                            <ElementPicker
                                                id="scene-setting"
                                                workspaceSlug={workspaceSlug}
                                                bookId={book.id}
                                                kinds={['SETTING']}
                                                selected={scene.setting}
                                                onSelect={(e) => void saveDetails({ settingElementId: e?.id ?? null })}
                                                placeholder={t('settingNone')}
                                                disabled={savingDetails}
                                            />
                                        </FormField>
                                        <FormField label={t('storyTime')} description={t('storyTimeHelp')}>
                                            <Input
                                                id="scene-story-time"
                                                value={storyTime}
                                                onChange={(e) => setStoryTime(e.target.value)}
                                                onBlur={() => {
                                                    if ((storyTime.trim() || null) !== scene.storyTime) void saveDetails({ storyTime: storyTime.trim() || null });
                                                }}
                                            />
                                        </FormField>
                                        <FormField label={t('beats')} description={t('beatsHelp')}>
                                            <ElementPicker
                                                id="scene-beat-add"
                                                workspaceSlug={workspaceSlug}
                                                bookId={book.id}
                                                kinds={['PLOT_BEAT']}
                                                selected={null}
                                                exclude={beatIds}
                                                onSelect={(e) => {
                                                    if (e) void saveDetails({ beatElementIds: [...beatIds, e.id] });
                                                }}
                                                placeholder={t('beatAdd')}
                                                disabled={savingDetails}
                                            />
                                        </FormField>
                                    </>
                                ) : (
                                    <dl className="space-y-tight text-sm">
                                        <dt className="font-medium text-content-emphasis">{t('pov')}</dt>
                                        <dd className="text-content-default">{scene.pov?.name ?? t('povNone')}</dd>
                                        <dt className="font-medium text-content-emphasis">{t('setting')}</dt>
                                        <dd className="text-content-default">{scene.setting?.name ?? t('settingNone')}</dd>
                                        <dt className="font-medium text-content-emphasis">{t('storyTime')}</dt>
                                        <dd className="text-content-default">{scene.storyTime ?? t('storyTimeNone')}</dd>
                                    </dl>
                                )}
                                <ul className="space-y-tight" aria-label={t('beats')} data-testid="scene-beats">
                                    {scene.beats.map((b) => (
                                        <li key={b.id} className="flex items-center justify-between gap-tight text-sm">
                                            <Link className="text-content-brand hover:underline" href={APP_ROUTES.bibleElement(workspaceSlug, book.id, b.id)}>
                                                {b.name}
                                            </Link>
                                            {canEdit ? (
                                                <Button variant="secondary" size="sm" onClick={() => void saveDetails({ beatElementIds: [...beatIds].filter((x) => x !== b.id) })} aria-label={t('beatRemove', { name: b.name })} icon={<X className="size-4" aria-hidden="true" />} />
                                            ) : null}
                                        </li>
                                    ))}
                                </ul>
                                {detailsError ? (
                                    <p className="text-sm text-content-error" role="alert">
                                        {detailsError}
                                    </p>
                                ) : null}
                            </Card>
                        ) : null}
                        {tab === 'links' ? (
                            <Card className="space-y-default p-4" data-testid="scene-links">
                                <p className="text-sm text-content-muted">{t('linksHelp')}</p>
                                {scene.links.length === 0 ? <p className="text-sm text-content-muted">{t('linksNone')}</p> : null}
                                <ul className="space-y-default">
                                    {scene.links.map((l) => (
                                        <li key={l.elementId} className="space-y-tight" data-testid="scene-link" data-element={l.elementId}>
                                            <div className="flex flex-wrap items-center gap-tight">
                                                <Link className="text-sm font-medium text-content-brand hover:underline" href={APP_ROUTES.bibleElement(workspaceSlug, book.id, l.elementId)}>
                                                    {l.name}
                                                </Link>
                                                <span className="text-xs text-content-muted">{kindLabel(l.kind)}</span>
                                                {l.mentioned ? <StatusBadge variant="info">{t('mentioned')}</StatusBadge> : null}
                                                {l.explicit ? <StatusBadge variant="neutral">{t('linked')}</StatusBadge> : null}
                                                {canEdit && l.explicit ? (
                                                    <Button
                                                        variant="secondary"
                                                        size="sm"
                                                        onClick={() => void saveDetails({ linkedElementIds: [...explicitIds].filter((x) => x !== l.elementId) })}
                                                        aria-label={t('unlink', { name: l.name })}
                                                        icon={<X className="size-4" aria-hidden="true" />}
                                                    />
                                                ) : null}
                                            </div>
                                            {l.summary ? <p className="text-sm text-content-default">{l.summary}</p> : <p className="text-xs text-content-muted">{t('noSummary')}</p>}
                                        </li>
                                    ))}
                                </ul>
                                {canEdit ? (
                                    <FormField label={t('linkAdd')}>
                                        <ElementPicker
                                            id="scene-link-add"
                                            workspaceSlug={workspaceSlug}
                                            bookId={book.id}
                                            kinds={BIBLE_KINDS}
                                            selected={null}
                                            exclude={explicitIds}
                                            kindLabel={kindLabel}
                                            onSelect={(e) => {
                                                if (e) void saveDetails({ linkedElementIds: [...explicitIds, e.id] });
                                            }}
                                            placeholder={t('linkAddPlaceholder')}
                                            disabled={savingDetails}
                                        />
                                    </FormField>
                                ) : null}
                            </Card>
                        ) : null}
                        {tab === 'note' ? (
                            <Card className="space-y-default p-4" data-testid="scene-note">
                                <p className="text-sm text-content-muted">{t('noteHelp')}</p>
                                {canEdit ? (
                                    <>
                                        <FormField label={t('note')}>
                                            <Textarea id="scene-note-input" rows={8} value={note} onChange={(e) => setNote(e.target.value)} />
                                        </FormField>
                                        <div className="flex items-center gap-default">
                                            <Button variant="secondary" size="sm" onClick={() => void saveNote()} loading={noteState === 'saving'} disabled={note === (scene.note ?? '')} id="scene-note-save">
                                                {t('noteSave')}
                                            </Button>
                                            <span className="text-xs text-content-muted" role="status">
                                                {noteState === 'saved' ? t('noteSaved') : noteState === 'error' ? t('noteFailed') : ''}
                                            </span>
                                        </div>
                                    </>
                                ) : (
                                    <p className="whitespace-pre-wrap text-sm text-content-default">{scene.note ?? t('noteNone')}</p>
                                )}
                            </Card>
                        ) : null}
                        {tab === 'history' ? (
                            <Card className="p-4">
                                <SceneHistoryPanel workspaceSlug={workspaceSlug} bookId={book.id} sceneId={initial.id} latestVersion={scene.latestVersion} canEdit={canEdit} onRestore={restore} />
                            </Card>
                        ) : null}
                    </aside>
                ) : null}
            </div>
        </div>
    );
}
