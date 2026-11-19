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
 *   header        save state, a disabled "Enrich" (it arrives with the
 *                 interviews, Phase 2) and delete with the undo toast
 *
 * What the viewer may do is the server's answer (`canEdit`, from
 * `bible.edit` on the page's context): a reader gets every value as text and
 * no edit, create, restore or delete affordance.
 *
 * DELETE follows the undo-toast convention: the page goes read-only at once
 * and the request is sent when the undo window closes; Undo gives the page
 * back. The book's home opens once the delete is done.
 */
import { useCallback, useMemo, useState } from 'react';
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
import { useApiErrorMessage } from './error-messages';
import { FieldEditor } from './FieldEditor';
import { HistoryPanel } from './HistoryPanel';
import { RelationsPanel, type BookElementOption } from './RelationsPanel';
import { useElementAutosave, type AutosaveState } from './use-element-autosave';

export interface ElementPageProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    element: ElementView;
    fieldDefs: FieldDef[];
    kindLabels: Record<BibleKind, string>;
    relationOptions: RelationOption[];
    bookElements: BookElementOption[];
    initialVersions: VersionMetaView[];
    /** The page size the versions were read with (a full page means older ones may exist). */
    versionPageSize: number;
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
    const { workspaceSlug, book, fieldDefs, kindLabels, relationOptions, bookElements, canEdit, versionPageSize } = props;
    const t = useTranslations('bible.element');
    const tDetails = useTranslations('bible.details');
    const tStatus = useTranslations('bible.status');
    const tHistory = useTranslations('bible.history');
    const errorMessage = useApiErrorMessage();
    const router = useRouter();
    const triggerUndo = useToastWithUndo();

    const [element, setElement] = useState(props.element);
    const [details, setDetails] = useState<Details>(() => detailsOf(props.element));
    const [values, setValues] = useState(() => valuesOf(props.element));
    // Bumped when the values are replaced from the server (a restore), so every editor re-reads them.
    const [revision, setRevision] = useState(0);
    const [tab, setTab] = useState<Tab>('fields');
    const [versions, setVersions] = useState(props.initialVersions);
    const [hasOlder, setHasOlder] = useState(props.initialVersions.length >= versionPageSize);
    const [deleting, setDeleting] = useState(false);
    const [nameError, setNameError] = useState(false);

    const editable = canEdit && !deleting;
    const ids = { slug: workspaceSlug, bookId: book.id, elementId: element.id };

    const autosave = useElementAutosave({
        workspaceSlug,
        bookId: book.id,
        elementId: element.id,
        enabled: editable,
        initialVersion: props.element.versionNumber,
        // Keep what the server says about the element (version, relations) without
        // touching what the author is typing.
        onSaved: (saved) => setElement((cur) => ({ ...cur, versionNumber: saved.versionNumber, updatedAt: saved.updatedAt, name: saved.name, status: saved.status })),
    });

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
        if (key === 'name') {
            const missing = value.trim() === '';
            setNameError(missing);
            if (missing) return;
        }
        if (key === 'customLabel' && value.trim() === '') return;
        autosave.setDetail(key, key === 'summary' && value.trim() === '' ? null : value);
    }

    function changeField(key: string, value: FieldValue | null) {
        setValues((m) => new Map(m).set(key, value));
        autosave.setField(key, value);
    }

    async function restore(n: number) {
        if (!(await autosave.flush())) {
            toast.error(t('restoreBlocked'));
            return;
        }
        try {
            const { restore: result } = await bibleFetch<{ restore: RestoreResult }>(BIBLE_API.restore(ids.slug, ids.bookId, ids.elementId, n), {
                method: 'POST',
                body: {},
            });
            const fresh = await reloadElement();
            setDetails(detailsOf(fresh));
            setValues(valuesOf(fresh));
            setRevision((r) => r + 1);
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
                router.push(APP_ROUTES.book(workspaceSlug, book.id));
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
                    <StatusBadge variant="info">{element.customLabel ? `${kindLabels[element.kind]} · ${element.customLabel}` : kindLabels[element.kind]}</StatusBadge>
                    <StatusBadge variant="neutral">{tStatus(details.status)}</StatusBadge>
                    {canEdit ? <SaveStatus state={autosave.state} error={autosave.error ? errorMessage(autosave.error.reason) : null} onRetry={() => void autosave.flush()} /> : null}
                </div>
            }
            actions={
                <div className="flex flex-wrap items-center gap-tight">
                    <Button variant="secondary" icon={<Sparkles className="size-4" aria-hidden="true" />} disabledTooltip={t('enrichSoon')} data-testid="enrich">
                        {t('enrich')}
                    </Button>
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
                <div className="xl:w-80">
                    <RelationsPanel
                        workspaceSlug={workspaceSlug}
                        bookId={book.id}
                        element={element}
                        options={relationOptions}
                        bookElements={bookElements}
                        kindLabels={kindLabels}
                        canEdit={editable}
                        onChanged={async () => {
                            await reloadElement();
                        }}
                    />
                </div>
            }
        >
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
                                    <FormField label={tDetails('customLabel')} required>
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
            <span role="status" aria-live="polite" className={state === 'error' ? 'text-content-error' : 'text-content-muted'}>
                {state === 'idle' ? t('idle') : state === 'pending' ? t('pending') : state === 'saving' ? t('saving') : state === 'saved' ? t('saved') : t('error', { reason: error ?? '' })}
            </span>
            {state === 'error' ? (
                <Button variant="secondary" size="sm" onClick={onRetry} data-testid="save-retry">
                    {t('retry')}
                </Button>
            ) : null}
        </span>
    );
}
