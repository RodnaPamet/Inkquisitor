'use client';

/**
 * Delete a book (Phase 1.H): the typed-confirmation modal CLAUDE.md's undo
 * convention asks for a top-level entity, whose cascade is too large for a
 * five-second undo toast.
 *
 * The export comes FIRST: the modal opens on the two exports (the Markdown
 * bundle, which imports back into any book, and the PDF), each downloaded
 * through `bibleDownload` so a refusal is shown rather than saved. Then the
 * consequence in plain words — the book leaves every list at once, its owner
 * can restore it from "Recently deleted" until the date shown, and after that
 * it and its whole history are deleted for good — and the confirmation:
 * Delete stays disabled until the book's title is typed exactly (case and
 * all; only spaces at either end are ignored).
 *
 * Offered only to a viewer the server says may delete (`books.delete`, the
 * workspace's OWNER).
 */
import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FileDown, FileText, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { formatDate } from '@inkquisitor/ui/lib/format-date';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, bibleFetch, reasonOf, type DeletedBookView } from '@/lib/bible/api-client';
import { BOOK_RESTORE_DAYS, restorableUntil } from '@/lib/bible/book-retention';
import { useApiErrorMessage } from './error-messages';
import { useExportDownload } from './use-export-download';

export interface DeleteBookModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    workspaceSlug: string;
    book: { id: string; title: string };
}

export function DeleteBookModal({ open, setOpen, workspaceSlug, book }: DeleteBookModalProps) {
    const t = useTranslations('bible.deleteBook');
    const tTransfer = useTranslations('bible.transfer');
    const errorMessage = useApiErrorMessage();
    const router = useRouter();
    const download = useExportDownload(workspaceSlug, book.id);
    const [typed, setTyped] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTyped('');
        setError(null);
    }, [open]);

    // The title as stored: case and inner spaces exactly, but the spaces a
    // paste or a keyboard leaves at either end do not count (the stored title
    // is trimmed, so they never can be part of it).
    const confirmed = typed.trim() === book.title;
    // The date a deletion now would stop being restorable, as the server computes it.
    const until = formatDate(restorableUntil(new Date()).toISOString());

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!confirmed) return;
        setSubmitting(true);
        setError(null);
        try {
            const { book: deleted } = await bibleFetch<{ book: DeletedBookView }>(BIBLE_API.book(workspaceSlug, book.id), { method: 'DELETE' });
            setOpen(false);
            toast.success(t('deleted', { title: book.title, date: formatDate(deleted.restorableUntil) }));
            router.push(APP_ROUTES.books(workspaceSlug));
            router.refresh();
        } catch (err) {
            setError(errorMessage(reasonOf(err)));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal showModal={open} setShowModal={setOpen} title={t('title', { title: book.title })}>
            <Modal.Form onSubmit={submit}>
                <Modal.Header title={t('title', { title: book.title })} description={t('description', { days: BOOK_RESTORE_DAYS, date: until })} />
                <Modal.Body className="space-y-default">
                    <section className="space-y-tight" aria-labelledby="delete-book-export-heading" data-testid="delete-book-export">
                        <h3 id="delete-book-export-heading" className="text-sm font-semibold text-content-emphasis">
                            {t('exportFirst')}
                        </h3>
                        <p className="text-sm text-content-muted">{t('exportFirstHelp')}</p>
                        <div className="flex flex-wrap gap-tight">
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                icon={<FileDown className="size-4" aria-hidden="true" />}
                                loading={download.busy === 'bundle'}
                                onClick={() => void download.start('bundle')}
                                id="delete-book-export-bundle"
                            >
                                {tTransfer('exportBundle')}
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                icon={<FileText className="size-4" aria-hidden="true" />}
                                loading={download.busy === 'pdf'}
                                onClick={() => void download.start('pdf')}
                                id="delete-book-export-pdf"
                            >
                                {tTransfer('exportPdf')}
                            </Button>
                        </div>
                    </section>
                    <FormField label={t('confirmLabel', { title: book.title })} description={t('confirmHelp')}>
                        <Input id="delete-book-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
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
                    <Button
                        type="submit"
                        variant="destructive"
                        icon={<Trash2 className="size-4" aria-hidden="true" />}
                        disabled={!confirmed}
                        loading={submitting}
                        id="delete-book-submit"
                    >
                        {t('submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
