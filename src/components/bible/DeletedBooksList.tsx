'use client';

/**
 * Recently deleted books (Phase 1.H), on the lifted `<EntityListPage>`: each
 * book deleted in the last 30 days, when it was deleted and until when it can
 * be restored. Restore brings the book back whole and opens it; past the
 * date the daily purge deletes it for good. The OWNER's page (`books.delete`).
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { RotateCcw, Trash2 } from 'lucide-react';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { createColumns } from '@/components/ui/table';
import { formatDate } from '@inkquisitor/ui/lib/format-date';
import { APP_ROUTES } from '@/lib/app-routes';
import { BIBLE_API, bibleFetch, reasonOf, type BookView, type DeletedBookView } from '@/lib/bible/api-client';
import { BOOK_RESTORE_DAYS } from '@/lib/bible/book-retention';
import { useApiErrorMessage } from './error-messages';

export interface DeletedBooksListProps {
    workspaceSlug: string;
    books: DeletedBookView[];
    truncated?: boolean;
}

export function DeletedBooksList({ workspaceSlug, books, truncated = false }: DeletedBooksListProps) {
    const t = useTranslations('bible.deletedBooks');
    const errorMessage = useApiErrorMessage();
    const router = useRouter();
    const [restoring, setRestoring] = useState<string | null>(null);

    const columns = useMemo(() => {
        async function restore(b: DeletedBookView) {
            setRestoring(b.id);
            try {
                const { book } = await bibleFetch<{ book: BookView }>(BIBLE_API.restoreBook(workspaceSlug, b.id), { method: 'POST' });
                toast.success(t('restored', { title: book.title }));
                router.push(APP_ROUTES.book(workspaceSlug, book.id));
            } catch (err) {
                toast.error(errorMessage(reasonOf(err)));
                setRestoring(null);
            }
        }
        return createColumns<DeletedBookView>([
            { id: 'title', header: t('columns.title'), cell: ({ row }) => <span className="font-medium text-content-emphasis">{row.original.title}</span> },
            { id: 'deleted', header: t('columns.deleted'), cell: ({ row }) => formatDate(row.original.deletedAt) },
            { id: 'until', header: t('columns.until'), cell: ({ row }) => formatDate(row.original.restorableUntil) },
            {
                id: 'restore',
                header: t('columns.action'),
                cell: ({ row }) => (
                    <Button
                        variant="secondary"
                        size="sm"
                        icon={<RotateCcw className="size-3.5" aria-hidden="true" />}
                        loading={restoring === row.original.id}
                        disabled={restoring !== null}
                        onClick={() => void restore(row.original)}
                        aria-label={t('restoreAria', { title: row.original.title })}
                        data-testid={`restore-book-${row.original.id}`}
                    >
                        {t('restore')}
                    </Button>
                ),
            },
        ]);
    }, [t, workspaceSlug, router, errorMessage, restoring]);

    return (
        <EntityListPage<DeletedBookView>
            header={{
                breadcrumbs: [{ label: t('breadcrumbBooks'), href: APP_ROUTES.books(workspaceSlug) }, { label: t('title') }],
                title: t('title'),
                description: truncated ? t('truncated', { count: books.length, days: BOOK_RESTORE_DAYS }) : t('description', { days: BOOK_RESTORE_DAYS }),
            }}
            table={{
                data: books,
                columns,
                getRowId: (b) => b.id,
                selectionEnabled: false,
                emptyState: <EmptyState icon={Trash2} title={t('empty')} description={t('emptyHint', { days: BOOK_RESTORE_DAYS })} />,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                'data-testid': 'deleted-books-table',
            }}
        />
    );
}
