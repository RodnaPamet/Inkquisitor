'use client';

/**
 * One bible element (Phase 1.2), on the lifted `<EntityDetailLayout>`:
 *
 *   Fields tab    the element's own columns (name, status, summary, a custom
 *                 element's label) and every template field, each edited
 *                 with its type's primitive and autosaved
 *                 (`useElementAutosave`: debounced, one request at a time,
 *                 each answered with a change writing one version)
 *   History tab   `<HistoryPanel>`: a diff between any two versions, and
 *                 restore as a new version
 *   rail          `<RelationsPanel>`
 *   header        save state, "Enrich" (Phase 2.4: opens the interview setup
 *                 sheet for this element, editors only) and delete with the
 *                 undo toast
 *
 * What the viewer may do is the server's answer (`canEdit`, from
 * `bible.edit` on the page's context): a reader gets every value as text and
 * no edit, create, restore or delete affordance.
 *
 * DELETE follows the undo-toast convention: the page goes read-only at once
 * and the request is sent when the undo window closes; Undo gives the page
 * back. The book's home opens once the delete is done.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Sparkles, Trash2 } from 'lucide-react';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { useToastWithUndo } from '@/components/ui/hooks';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, bibleFetch, reasonOf, type ElementView, type RestoreResult, type VersionMetaView } from '@/lib/bible/api-client';
import type { FieldValue } from '@/lib/bible/field-values';
import { BIBLE_ELEMENT_STATUSES, type BibleKind } from '@/lib/bible/kinds';
import type { FieldDef } from '@/lib/bible/template-schema';
import type { RelationOption } from '@/lib/bible/ui-model';
import { InterviewLauncher } from '@/components/interview/InterviewLauncher';
import { useApiErrorMessage } from './error-messages';
import { FieldEditor } from './FieldEditor';
import { HistoryPanel } from './HistoryPanel';
import { RelationsPanel } from './RelationsPanel';
import { useElementAutosave, type AutosaveState } from './use-element-autosave';
import { StoryMapPreview } from '@/components/canvas/StoryMapPreview';
import { BeatScenesList } from '@/components/manuscript/BeatScenesList';
import type { StoryMapView } from '@/lib/canvas/api-client';
import type { StoryMapKindValue } from '@/lib/canvas/map-kinds';

export interface ElementPageProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    element: ElementView;
    fieldDefs: FieldDef[];
    kindLabels: Record<BibleKind, string>;
    relationOptions: RelationOption[];
    initialVersions: VersionMetaView[];
    /** The page size the versions were read with (a full page means older ones may exist). */
    versionPageSize: number;
    /** The story maps that draw this element's kind (Phase 3.2), shown read-only in the rail. */
    mapPreviews?: Array<{ kind: StoryMapKindValue; map: StoryMapView }>;
    canEdit: boolean;
}

type Tab = 'fields' | 'history';

interface Details {
    name: string;
    status: string;
    summary: string;
    customLabel: string;
}

const detailsOf = (e: ElementView): Details => ({ name: e.name, status: e.status, summary: e.summary ?? '', customLabel: e.customLabel ?? '' });
const valuesOf = (e: ElementView) => new Map<string, FieldValue | null>(e.fields.map((f) => [f.key, f.value as FieldValue | null]));

export function ElementPage(props: ElementPageProps) {
    const { workspaceSlug, book, fieldDefs, kindLabels, relationOptions, canEdit, versionPageSize, mapPreviews = [] } = props;
    const t = useTranslations('bible.element');
    const tDetails = useTranslations('bible.details');
    const tStatus = useTranslations('bible.status');
    const tHistory = useTranslations('bible.history');
    const tInterview = useTranslations('interview.setup');
    const errorMessage = useApiErrorMessage();
    const router = useRouter();
    const triggerUndo = useToastWithUndo();

    const [element, setElement] = useState(props.element);
    const [deleting, setDeleting] = useState(false);
    const editable = canEdit && !deleting;
    const autosave = useElementAutosave({
        workspaceSlug,
        bookId: book.id,
        elementId: props.element.id,
        enabled: editable,
        initialVersion: props.element.versionNumber,
        // Keep what the server says about the element (version, relations) without
        // touching what the author is typing.
        onSaved: (saved) => setElement((cur) => ({ ...cur, versionNumber: saved.versionNumber, updatedAt: saved.updatedAt, name: saved.name, status: saved.status })),
        // The page navigated to was rendered before these edits landed.
        onSavedAfterUnmount: () => router.refresh(),
        // Leaving by a link while edits are held in a conflict asks first.
        leaveConflictMessage: t('conflictLeave'),
    });
    // The inputs show the element as loaded, under any edits this page held in
    // a conflict when it was last left (they come back, still unsaved).
    const [details, setDetails] = useState<Details>(() => {
        const d = detailsOf(props.element);
        for (const [key, value] of autosave.restored?.details ?? []) d[key] = value ?? '';
        return d;
    });
    const [values, setValues] = useState(() => {
        const v = valuesOf(props.element);
        for (const [key, value] of autosave.restored?.fields ?? []) v.set(key, value);
        return v;
    });
    // Bumped when the values are replaced from the server (a restore), so every editor re-reads them.
    const [revision, setRevision] = useState(0);
    const [tab, setTab] = useState<Tab>('fields');
    const [versions, setVersions] = useState(props.initialVersions);
    const [hasOlder, setHasOlder] = useState(props.initialVersions.length >= versionPageSize);
    const [nameError, setNameError] = useState(false);
    const [customLabelError, setCustomLabelError] = useState(false);

    // Whether this page is still the one shown: a delete's commit, after the
    // undo window, must not take an author who has since gone elsewhere back
    // to this book.
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const ids = { slug: workspaceSlug, bookId: book.id, elementId: element.id };

    const loadVersions = useCallback(async () => {
        const { versions: page } = await bibleFetch<{ versions: VersionMetaView[] }>(
            BIBLE_API.versions(ids.slug, ids.bookId, ids.elementId, { take: versionPageSize }),
        );
        setVersions(page);
        setHasOlder(page.length >= versionPageSize);
    }, [ids.slug, ids.bookId, ids.elementId, versionPageSize]);

    const loadOlder = useCallback(async () => {
        const oldest = versions[versions.length - 1]?.versionNumber;
        if (!oldest) return;
        const { versions: page } = await bibleFetch<{ versions: VersionMetaView[] }>(
            BIBLE_API.versions(ids.slug, ids.bookId, ids.elementId, { take: versionPageSize, before: oldest }),
        );
        setVersions((v) => [...v, ...page]);
        setHasOlder(page.length >= versionPageSize);
    }, [versions, ids.slug, ids.bookId, ids.elementId, versionPageSize]);

    const reloadElement = useCallback(async () => {
        const { element: fresh } = await bibleFetch<{ element: ElementView }>(BIBLE_API.element(ids.slug, ids.bookId, ids.elementId));
        setElement(fresh);
        return fresh;
    }, [ids.slug, ids.bookId, ids.elementId]);

    function openTab(next: Tab) {
        setTab(next);
        // The history moves with every save: read it fresh each time it is opened.
        if (next === 'history') {
            void autosave.flush().then(() => loadVersions().catch(() => toast.error(tHistory('loadFailed'))));
        }
    }

    function changeDetail<K extends keyof Details>(key: K, value: string) {
        setDetails((d) => ({ ...d, [key]: value }));
        // A value that may not be saved drops the edit still waiting, so the
        // last SAVED value stands rather than a keystroke on the way here.
        if (key === 'name') {
            const missing = value.trim() === '';
            setNameError(missing);
            if (missing) {
                autosave.discardDetail('name');
                return;
            }
        }
        if (key === 'customLabel') {
            const missing = value.trim() === '';
            setCustomLabelError(missing);
            if (missing) {
                autosave.discardDetail('customLabel');
                return;
            }
        }
        autosave.setDetail(key, key === 'summary' && value.trim() === '' ? null : value);
    }

    function changeField(key: string, value: FieldValue | null) {
        setValues((m) => new Map(m).set(key, value));
        autosave.setField(key, value);
    }

    /** Put the element as the server now holds it into every input, and make it the base of the next save. */
    function reseed(fresh: ElementView) {
        setDetails(detailsOf(fresh));
        setValues(valuesOf(fresh));
        setNameError(false);
        setCustomLabelError(false);
        setRevision((r) => r + 1);
        autosave.setBaseVersion(fresh.versionNumber);
    }

    // Someone else saved since this page's base (Phase 1.H): the author chooses.
    const [resolving, setResolving] = useState(false);
    async function reloadTheirs() {
        setResolving(true);
        try {
            autosave.discardAll();
            reseed(await reloadElement());
            if (tab === 'history') await loadVersions();
        } catch {
            toast.error(t('conflictReloadFailed'));
        } finally {
            setResolving(false);
        }
    }
    async function keepMine() {
        setResolving(true);
        try {
            await autosave.keepMine();
        } finally {
            setResolving(false);
        }
    }

    async function restore(n: number) {
        if (!(await autosave.flush())) {
            toast.error(t('restoreBlocked'));
            return;
        }
        try {
            const { restore: result } = await bibleFetch<{ restore: RestoreResult }>(BIBLE_API.restore(ids.slug, ids.bookId, ids.elementId, n), {
                method: 'POST',
                body: { baseVersion: autosave.baseVersion() },
            });
            // The restore is a new version: the next save is based on it.
            autosave.setBaseVersion(result.version.versionNumber);
            reseed(await reloadElement());
            await loadVersions();
            toast.success(t('restored', { from: result.restoredFromVersion, to: result.version.versionNumber }));
        } catch (err) {
            toast.error(errorMessage(reasonOf(err)));
        }
    }

    function remove() {
        setDeleting(true);
        triggerUndo({
            message: t('deleted', { name: details.name || element.name }),
            undoMessage: t('undo'),
            action: () => bibleFetch(BIBLE_API.element(ids.slug, ids.bookId, ids.elementId), { method: 'DELETE' }),
            undoAction: () => setDeleting(false),
            onCommit: () => {
                // Only an author still on this page is taken to the book;
                // one who has left has the page they are on re-read.
                if (mounted.current) router.push(APP_ROUTES.book(workspaceSlug, book.id));
                router.refresh();
            },
            onError: () => {
                setDeleting(false);
                toast.error(t('deleteFailed'));
            },
        });
    }

    const statusOptions = useMemo(() => BIBLE_ELEMENT_STATUSES.map((s) => ({ value: s, label: tStatus(s) })), [tStatus]);
    const refusedKeys = new Set(autosave.error?.fieldKeys ?? []);
    // As with the title: what the author has typed, or the saved label while the input is empty.
    const customLabelShown = details.customLabel.trim() || element.customLabel;

    return (
        <EntityDetailLayout<Tab>
            id="bible-element"
            breadcrumbs={[
                { label: t('breadcrumbBooks'), href: APP_ROUTES.books(workspaceSlug) },
                { label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) },
                { label: details.name || element.name },
            ]}
            title={details.name || element.name}
            meta={
                <div className="flex flex-wrap items-center gap-tight">
                    <StatusBadge variant="info">{customLabelShown ? `${kindLabels[element.kind]} · ${customLabelShown}` : kindLabels[element.kind]}</StatusBadge>
                    <StatusBadge variant="neutral">{tStatus(details.status)}</StatusBadge>
                    {canEdit ? <SaveStatus state={autosave.state} error={autosave.error ? errorMessage(autosave.error.reason) : null} onRetry={() => void autosave.flush()} /> : null}
                    {element.relationsTruncated ? <StatusBadge variant="warning">{t('relationsTruncated')}</StatusBadge> : null}
                </div>
            }
            actions={
                <div className="flex flex-wrap items-center gap-tight">
                    {canEdit ? (
                        <InterviewLauncher
                            workspaceSlug={workspaceSlug}
                            bookId={book.id}
                            target={{ scope: 'ELEMENT', elementId: element.id }}
                            title={tInterview('titleElement', { name: details.name || element.name })}
                            label={t('enrich')}
                            icon={<Sparkles className="size-4" aria-hidden="true" />}
                            disabled={deleting}
                            data-testid="enrich"
                            id="element-enrich"
                        />
                    ) : null}
                    {canEdit ? (
                        <Button variant="secondary" icon={<Trash2 className="size-4" aria-hidden="true" />} onClick={remove} disabled={deleting} id="element-delete">
                            {t('delete')}
                        </Button>
                    ) : null}
                </div>
            }
            tabs={[
                { key: 'fields', label: t('tabFields') },
                { key: 'history', label: t('tabHistory') },
            ]}
            activeTab={tab}
            onTabChange={openTab}
            rail={
                <div className="space-y-section xl:w-80">
                    <RelationsPanel
                        workspaceSlug={workspaceSlug}
                        bookId={book.id}
                        element={element}
                        options={relationOptions}
                        kindLabels={kindLabels}
                        canEdit={editable}
                        onChanged={async () => {
                            await reloadElement();
                        }}
                    />
                    {element.kind === 'PLOT_BEAT' ? (
                        <Card className="p-5">
                            <BeatScenesList workspaceSlug={workspaceSlug} bookId={book.id} elementId={element.id} />
                        </Card>
                    ) : null}
                    {mapPreviews.map((p) => (
                        <Card key={p.kind} className="p-5">
                            <StoryMapPreview workspaceSlug={workspaceSlug} bookId={book.id} mapKind={p.kind} map={p.map} currentElementId={element.id} kindLabels={kindLabels} />
                        </Card>
                    ))}
                </div>
            }
        >
            {autosave.conflict ? (
                <div className="space-y-default rounded-lg border border-border-default bg-bg-warning p-4" role="alert" data-testid="version-conflict">
                    <div className="space-y-tight">
                        <p className="text-sm font-semibold text-content-warning">{t('conflictTitle')}</p>
                        <p className="text-sm text-content-default">{t('conflictBody', { version: autosave.conflict.currentVersion })}</p>
                    </div>
                    <div className="flex flex-wrap gap-tight">
                        <Button variant="secondary" size="sm" onClick={() => void reloadTheirs()} disabled={resolving} id="conflict-reload">
                            {t('conflictReload')}
                        </Button>
                        <Button variant="primary" size="sm" onClick={() => void keepMine()} disabled={resolving} id="conflict-keep">
                            {t('conflictKeep')}
                        </Button>
                    </div>
                </div>
            ) : null}
            {deleting ? (
                <p className="rounded-lg border border-border-default bg-bg-warning p-3 text-sm text-content-warning" role="status">
                    {t('deleting')}
                </p>
            ) : null}
            {tab === 'fields' ? (
                <>
                    <Card className="space-y-default p-5" data-testid="element-details">
                        <h2 className="text-base font-semibold text-content-emphasis">{tDetails('title')}</h2>
                        {editable ? (
                            <>
                                <FormField label={tDetails('name')} required error={nameError ? tDetails('nameRequired') : undefined}>
                                    <Input id="element-name" value={details.name} onChange={(e) => changeDetail('name', e.target.value)} autoComplete="off" />
                                </FormField>
                                {element.kind === 'CUSTOM' ? (
                                    <FormField label={tDetails('customLabel')} required error={customLabelError ? tDetails('customLabelRequired') : undefined}>
                                        <Input id="element-custom-label" value={details.customLabel} onChange={(e) => changeDetail('customLabel', e.target.value)} />
                                    </FormField>
                                ) : null}
                                <div role="group" aria-labelledby="element-status-label" className="space-y-tight">
                                    <p id="element-status-label" className="text-sm font-medium text-content-emphasis">
                                        {tDetails('status')}
                                    </p>
                                    <ToggleGroup ariaLabel={tDetails('status')} options={statusOptions} selected={details.status} selectAction={(s) => changeDetail('status', s)} />
                                </div>
                                <FormField label={tDetails('summary')} description={tDetails('summaryHelp')}>
                                    <Textarea id="element-summary" value={details.summary} onChange={(e) => changeDetail('summary', e.target.value)} rows={3} />
                                </FormField>
                            </>
                        ) : (
                            <dl className="space-y-tight text-sm">
                                <dt className="font-medium text-content-emphasis">{tDetails('summary')}</dt>
                                <dd className="whitespace-pre-wrap text-content-default">{details.summary || tDetails('noSummary')}</dd>
                            </dl>
                        )}
                    </Card>
                    <Card className="space-y-section p-5" data-testid="element-fields">
                        <h2 className="text-base font-semibold text-content-emphasis">{t('fieldsTitle')}</h2>
                        {fieldDefs.map((def) => (
                            <FieldEditor
                                key={`${def.key}:${revision}`}
                                def={def}
                                value={values.get(def.key) ?? null}
                                onChange={(v) => changeField(def.key, v)}
                                readOnly={!editable}
                                refused={refusedKeys.has(def.key)}
                            />
                        ))}
                    </Card>
                </>
            ) : (
                <HistoryPanel
                    workspaceSlug={workspaceSlug}
                    bookId={book.id}
                    elementId={element.id}
                    fieldDefs={fieldDefs}
                    versions={versions}
                    hasOlder={hasOlder}
                    onLoadOlder={loadOlder}
                    canEdit={editable}
                    onRestore={restore}
                />
            )}
        </EntityDetailLayout>
    );
}

function SaveStatus({ state, error, onRetry }: { state: AutosaveState; error: string | null; onRetry: () => void }) {
    const t = useTranslations('bible.autosave');
    return (
        <span className="inline-flex items-center gap-tight text-xs" data-testid="save-status" data-state={state}>
            <span role="status" aria-live="polite" className={state === 'error' || state === 'conflict' ? 'text-content-error' : 'text-content-muted'}>
                {state === 'idle'
                    ? t('idle')
                    : state === 'pending'
                      ? t('pending')
                      : state === 'saving'
                        ? t('saving')
                        : state === 'saved'
                          ? t('saved')
                          : state === 'conflict'
                            ? t('conflict')
                            : t('error', { reason: error ?? '' })}
            </span>
            {state === 'error' ? (
                <Button variant="secondary" size="sm" onClick={onRetry} data-testid="save-retry">
                    {t('retry')}
                </Button>
            ) : null}
        </span>
    );
}
