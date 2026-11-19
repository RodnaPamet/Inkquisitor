'use client';

/**
 * Create a book (Phase 1.2): a title and, optionally, a working logline. The
 * API answers with the book, and the modal opens its home.
 */
import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, bibleFetch, reasonOf, type BookView } from '@/lib/bible/api-client';
import { useApiErrorMessage } from './error-messages';

export interface CreateBookModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    workspaceSlug: string;
}

export function CreateBookModal({ open, setOpen, workspaceSlug }: CreateBookModalProps) {
    const t = useTranslations('bible.createBook');
    const errorMessage = useApiErrorMessage();
    const router = useRouter();
    const [title, setTitle] = useState('');
    const [logline, setLogline] = useState('');
    const [touched, setTouched] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTitle('');
        setLogline('');
        setTouched(false);
        setError(null);
    }, [open]);

    const titleMissing = title.trim() === '';

    async function submit(e: FormEvent) {
        e.preventDefault();
        setTouched(true);
        if (titleMissing) return;
        setSubmitting(true);
        setError(null);
        try {
            const { book } = await bibleFetch<{ book: BookView }>(BIBLE_API.books(workspaceSlug), {
                method: 'POST',
                body: { title, ...(logline.trim() !== '' ? { logline } : {}) },
            });
            setOpen(false);
            router.push(APP_ROUTES.book(workspaceSlug, book.id));
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
                    <FormField label={t('bookTitle')} required error={touched && titleMissing ? t('titleRequired') : undefined}>
                        <Input id="create-book-title" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
                    </FormField>
                    <FormField label={t('logline')} description={t('loglineHelp')}>
                        <Textarea id="create-book-logline" value={logline} onChange={(e) => setLogline(e.target.value)} rows={3} />
                    </FormField>
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
                    <Button type="submit" variant="primary" loading={submitting} id="create-book-submit">
                        {t('submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
