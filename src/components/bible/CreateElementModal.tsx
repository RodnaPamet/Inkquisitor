'use client';

/**
 * Create a bible element (Phase 1.2): kind, name and, for a CUSTOM element,
 * its own label. The API writes version 1 and answers with the element; the
 * modal then opens its page. Opened from the board's header (no kind chosen)
 * or from a kind's card (that kind chosen).
 */
import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, bibleFetch, reasonOf, type ElementView } from '@/lib/bible/api-client';
import type { BibleKind } from '@/lib/bible/kinds';
import type { KindSummary } from '@/lib/bible/ui-model';
import { useApiErrorMessage } from './error-messages';

export interface CreateElementModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    workspaceSlug: string;
    bookId: string;
    kinds: KindSummary[];
    /** The kind to start with (a kind card's "add"), or none. */
    initialKind: BibleKind | null;
}

export function CreateElementModal({ open, setOpen, workspaceSlug, bookId, kinds, initialKind }: CreateElementModalProps) {
    const t = useTranslations('bible.createElement');
    const errorMessage = useApiErrorMessage();
    const router = useRouter();
    const [kind, setKind] = useState<BibleKind | null>(initialKind);
    const [name, setName] = useState('');
    const [customLabel, setCustomLabel] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [touched, setTouched] = useState(false);

    // Each opening starts clean, with the kind it was opened for.
    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setKind(initialKind);
        setName('');
        setCustomLabel('');
        setError(null);
        setTouched(false);
    }, [open, initialKind]);

    const options: ComboboxOption[] = kinds.map((k) => ({ value: k.kind, label: k.label }));
    const selected = options.find((o) => o.value === kind) ?? null;
    const nameMissing = name.trim() === '';
    const labelMissing = kind === 'CUSTOM' && customLabel.trim() === '';

    async function submit(e: FormEvent) {
        e.preventDefault();
        setTouched(true);
        if (!kind || nameMissing || labelMissing) return;
        setSubmitting(true);
        setError(null);
        try {
            const { element } = await bibleFetch<{ element: ElementView }>(BIBLE_API.elements(workspaceSlug, bookId), {
                method: 'POST',
                body: { kind, name, ...(kind === 'CUSTOM' ? { customLabel } : {}) },
            });
            setOpen(false);
            router.push(APP_ROUTES.bibleElement(workspaceSlug, bookId, element.id));
        } catch (err) {
            setError(errorMessage(reasonOf(err)));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal showModal={open} setShowModal={setOpen} title={t('title')}>
            <Modal.Form onSubmit={submit}>
                <Modal.Header title={t('title')} description={t('description')} />
                <Modal.Body className="space-y-default">
                    <FormField label={t('kind')} required error={touched && !kind ? t('kindRequired') : undefined}>
                        <Combobox
                            options={options}
                            selected={selected}
                            setSelected={(o) => setKind(o ? (o.value as BibleKind) : null)}
                            placeholder={t('kindPlaceholder')}
                            searchPlaceholder={t('kindSearch')}
                            matchTriggerWidth
                            id="create-element-kind"
                        />
                    </FormField>
                    <FormField label={t('name')} required error={touched && nameMissing ? t('nameRequired') : undefined}>
                        <Input id="create-element-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
                    </FormField>
                    {kind === 'CUSTOM' ? (
                        <FormField
                            label={t('customLabel')}
                            description={t('customLabelHelp')}
                            required
                            error={touched && labelMissing ? t('customLabelRequired') : undefined}
                        >
                            <Input id="create-element-custom-label" value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} autoComplete="off" />
                        </FormField>
                    ) : null}
                    {error ? (
                        <p className="text-sm text-content-error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </Modal.Body>
                <Modal.Actions>
                    <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                        {t('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" loading={submitting} id="create-element-submit">
                        {t('submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
