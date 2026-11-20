'use client';

/**
 * One element, opened from a story map without leaving it (Phase 3.2): its
 * name, completeness and every template field, edited with the element page's
 * own parts — `FieldEditor` for each field and `useElementAutosave` for the
 * versioned save (debounced, one request at a time, `baseVersion` named, a
 * conflict held for the author to resolve). The canvas and the bible are the
 * same rows: every save is told to the host (`onSaved`), which reads the map
 * again so the card shows what the bible now says.
 *
 * On a derived map the sheet also carries the keyboard's way to move the
 * element in its story order ("Earlier" / "Later": the list-view equivalent
 * of a drag, `stepMove`): unsaved edits are saved first, and the move's new
 * version becomes the next save's base.
 *
 * A reader sees every value as text and no control. The element is read
 * fresh each time the sheet opens, so an edit made on its page meanwhile is
 * what the sheet shows.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight } from 'lucide-react';

import { CompletenessMeter } from '@/components/bible/CompletenessMeter';
import { useApiErrorMessage } from '@/components/bible/error-messages';
import { FieldEditor } from '@/components/bible/FieldEditor';
import { useElementAutosave } from '@/components/bible/use-element-autosave';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, BibleApiError, bibleFetch, reasonOf, type ElementView } from '@/lib/bible/api-client';
import { completeness } from '@/lib/bible/completeness';
import type { FieldValue } from '@/lib/bible/field-values';
import type { FieldDef } from '@/lib/bible/template-schema';

export interface SheetOrderControls {
    canEarlier: boolean;
    canLater: boolean;
    /** Move one place; resolves the element's new version, or null when nothing moved. */
    move: (direction: 'earlier' | 'later', baseVersion: number) => Promise<number | null>;
}

export interface ElementSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workspaceSlug: string;
    bookId: string;
    /** The element to show; null while the sheet is closed. */
    elementId: string | null;
    /** Template fields by kind, for the kinds this map draws. */
    fieldDefs: Readonly<Record<string, FieldDef[]>>;
    kindLabels: Readonly<Record<string, string>>;
    canEdit: boolean;
    /** Told after every save the API answered (the host refreshes the map). */
    onSaved?: (element: ElementView) => void;
    /** On a derived map: move the element in its story order. */
    order?: SheetOrderControls | null;
}

const filledOf = (e: ElementView) => e.fields.filter((f) => f.value !== null).length;

function SheetBody({
    workspaceSlug,
    bookId,
    initial,
    fieldDefs,
    kindLabel,
    canEdit,
    onSaved,
    order,
}: {
    workspaceSlug: string;
    bookId: string;
    initial: ElementView;
    fieldDefs: FieldDef[];
    kindLabel: string;
    canEdit: boolean;
    onSaved?: (element: ElementView) => void;
    order?: SheetOrderControls | null;
}) {
    const t = useTranslations('canvas.sheet');
    const errorMessage = useApiErrorMessage();
    const [element, setElement] = useState(initial);
    const [name, setName] = useState(initial.name);
    const [nameMissing, setNameMissing] = useState(false);
    const [values, setValues] = useState(() => new Map<string, FieldValue | null>(initial.fields.map((f) => [f.key, f.value as FieldValue | null])));
    const [moving, setMoving] = useState(false);
    const [moveError, setMoveError] = useState<string | null>(null);
    const autosave = useElementAutosave({
        workspaceSlug,
        bookId,
        elementId: initial.id,
        enabled: canEdit,
        initialVersion: initial.versionNumber,
        onSaved: (saved) => {
            setElement(saved);
            onSaved?.(saved);
        },
    });

    function changeField(key: string, value: FieldValue | null) {
        setValues((m) => new Map(m).set(key, value));
        autosave.setField(key, value);
    }

    function changeName(value: string) {
        setName(value);
        const missing = value.trim() === '';
        setNameMissing(missing);
        if (missing) autosave.discardDetail('name');
        else autosave.setDetail('name', value);
    }

    async function move(direction: 'earlier' | 'later') {
        if (!order || moving) return;
        setMoving(true);
        setMoveError(null);
        try {
            if (!(await autosave.flush())) {
                setMoveError(t('moveBlocked'));
                return;
            }
            const version = await order.move(direction, autosave.baseVersion());
            if (version !== null) autosave.setBaseVersion(version);
        } catch (err) {
            setMoveError(errorMessage(reasonOf(err)));
        } finally {
            setMoving(false);
        }
    }

    // What is filled now, the author's unsaved edits included.
    const filled = useMemo(() => fieldDefs.filter((d) => values.get(d.key) !== null && values.get(d.key) !== undefined).length, [fieldDefs, values]);
    const measured = completeness({ entries: 1, filled: canEdit ? filled : filledOf(element), fieldsPerEntry: fieldDefs.length });
    const refused = new Set(autosave.error?.fieldKeys ?? []);

    return (
        <div className="space-y-section" data-testid="element-sheet-body" data-element-id={initial.id}>
            <div className="space-y-default">
                <p className="text-xs font-medium uppercase tracking-wide text-content-muted">{kindLabel}</p>
                {canEdit ? (
                    <FormField label={t('name')} required error={nameMissing ? t('nameRequired') : undefined}>
                        <Input id="element-sheet-name" value={name} onChange={(e) => changeName(e.target.value)} autoComplete="off" />
                    </FormField>
                ) : (
                    <p className="text-base font-semibold text-content-emphasis">{element.name}</p>
                )}
                <CompletenessMeter value={measured} label={t('completeness')} />
                {canEdit ? (
                    <p className="text-xs text-content-muted" role="status" aria-live="polite" data-testid="element-sheet-save" data-state={autosave.state}>
                        {autosave.state === 'error' ? errorMessage(autosave.error?.reason ?? null) : t(`save.${autosave.state}`)}
                    </p>
                ) : null}
                {autosave.conflict ? (
                    <div className="space-y-tight rounded-md border border-border-default bg-bg-warning p-3" role="alert" data-testid="element-sheet-conflict">
                        <p className="text-sm text-content-default">{t('conflict', { version: autosave.conflict.currentVersion })}</p>
                        <Button variant="primary" size="sm" onClick={() => void autosave.keepMine()} id="element-sheet-keep">
                            {t('keepMine')}
                        </Button>
                    </div>
                ) : null}
                {order && canEdit ? (
                    <div className="space-y-tight" role="group" aria-label={t('orderLabel')}>
                        <p className="text-sm font-medium text-content-emphasis">{t('orderLabel')}</p>
                        <div className="flex flex-wrap gap-tight">
                            <Button
                                variant="secondary"
                                size="sm"
                                icon={<ArrowLeft className="size-4" aria-hidden="true" />}
                                disabled={!order.canEarlier || moving}
                                onClick={() => void move('earlier')}
                                id="element-sheet-earlier"
                            >
                                {t('earlier')}
                            </Button>
                            <Button
                                variant="secondary"
                                size="sm"
                                icon={<ArrowRight className="size-4" aria-hidden="true" />}
                                disabled={!order.canLater || moving}
                                onClick={() => void move('later')}
                                id="element-sheet-later"
                            >
                                {t('later')}
                            </Button>
                        </div>
                        {moveError ? (
                            <p className="text-xs text-content-error" role="alert">
                                {moveError}
                            </p>
                        ) : null}
                    </div>
                ) : null}
            </div>
            <div className="space-y-section" data-testid="element-sheet-fields">
                {fieldDefs.map((def) => (
                    <FieldEditor key={def.key} def={def} value={values.get(def.key) ?? null} onChange={(v) => changeField(def.key, v)} readOnly={!canEdit} refused={refused.has(def.key)} />
                ))}
            </div>
            <Link className="inline-block text-sm font-medium text-content-brand underline-offset-2 hover:underline" href={APP_ROUTES.bibleElement(workspaceSlug, bookId, initial.id)}>
                {t('openPage')}
            </Link>
        </div>
    );
}

/** The element, read fresh when the sheet opens (mounted once per opening). */
function SheetLoader(props: Omit<ElementSheetProps, 'open' | 'onOpenChange' | 'elementId'> & { elementId: string; onTitle: (title: string) => void }) {
    const { workspaceSlug, bookId, elementId, fieldDefs, kindLabels, canEdit, onSaved, order, onTitle } = props;
    const t = useTranslations('canvas.sheet');
    const [element, setElement] = useState<ElementView | null>(null);
    const [failed, setFailed] = useState<'gone' | 'error' | null>(null);

    useEffect(() => {
        let live = true;
        bibleFetch<{ element: ElementView }>(BIBLE_API.element(workspaceSlug, bookId, elementId))
            .then(({ element: fresh }) => {
                if (!live) return;
                setElement(fresh);
                onTitle(fresh.name);
            })
            .catch((err: unknown) => {
                if (live) setFailed(err instanceof BibleApiError && err.status === 404 ? 'gone' : 'error');
            });
        return () => {
            live = false;
        };
    }, [workspaceSlug, bookId, elementId, onTitle]);

    if (failed) {
        return (
            <p className="text-sm text-content-muted" role="alert" data-testid="element-sheet-failed">
                {failed === 'gone' ? t('gone') : t('loadError')}
            </p>
        );
    }
    if (!element) {
        return (
            <p className="text-sm text-content-muted" data-testid="element-sheet-loading">
                {t('loading')}
            </p>
        );
    }
    return (
        <SheetBody
            workspaceSlug={workspaceSlug}
            bookId={bookId}
            initial={element}
            fieldDefs={fieldDefs[element.kind] ?? []}
            kindLabel={element.customLabel ?? kindLabels[element.kind] ?? element.kind}
            canEdit={canEdit}
            onSaved={(saved) => {
                onTitle(saved.name);
                onSaved?.(saved);
            }}
            order={order}
        />
    );
}

export function ElementSheet({ open, onOpenChange, elementId, ...rest }: ElementSheetProps) {
    const t = useTranslations('canvas.sheet');
    const [title, setTitle] = useState<string | null>(null);
    const onTitle = useCallback((next: string) => setTitle(next), []);
    return (
        <Sheet
            open={open}
            onOpenChange={(next) => {
                if (!next) setTitle(null);
                onOpenChange(next);
            }}
            size="md"
            title={title ?? t('loadingTitle')}
        >
            <Sheet.Body>{open && elementId ? <SheetLoader key={elementId} elementId={elementId} onTitle={onTitle} {...rest} /> : null}</Sheet.Body>
        </Sheet>
    );
}
