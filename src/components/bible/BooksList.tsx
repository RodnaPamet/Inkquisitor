'use client';

/**
 * The workspace's books (Phase 1.2), on the lifted `<EntityListPage>`. A
 * row opens the book's home; an author who may edit gets the create button,
 * which opens `<CreateBookModal>`. Whether they may is the server's answer
 * (`bible.edit` on the page's context), passed in as `canEdit`.
 *
 * The list holds the most recently updated `BOOK_LIST_MAX` books and says so
 * when the workspace has more (`truncated`, Phase 1.H). The workspace's
 * OWNER (`canManageDeleted`, `books.delete`) also gets "Recently deleted",
 * where a deleted book can be restored for 30 days.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Library, Plus, Trash2 } from 'lucide-react';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { createColumns } from '@/components/ui/table';
import { formatDate } from '@inkquisitor/ui/lib/format-date';
import { APP_ROUTES } from '@/lib/app-routes';
import type { BookView } from '@/lib/bible/api-client';
import { CreateBookModal } from './CreateBookModal';

export interface BooksListProps {
    workspaceSlug: string;
    books: BookView[];
    /** The workspace holds more live books than `books` (the most recently updated). */
    truncated?: boolean;
    canEdit: boolean;
    /** The viewer may see and restore deleted books (`books.delete`). */
    canManageDeleted?: boolean;
}

export function BooksList({ workspaceSlug, books, truncated = false, canEdit, canManageDeleted = false }: BooksListProps) {
    const tSources = useTranslations('sources');
    const t = useTranslations('bible.books');
    const tStage = useTranslations('bible.stage');
    const router = useRouter();
    const [creating, setCreating] = useState(false);

    const columns = useMemo(
        () =>
            createColumns<BookView>([
                {
                    id: 'title',
                    header: t('columns.title'),
                    cell: ({ row }) => (
                        <Link href={APP_ROUTES.book(workspaceSlug, row.original.id)} className="font-medium text-content-emphasis hover:underline">
                            {row.original.title}
                        </Link>
                    ),
                },
                { id: 'stage', header: t('columns.stage'), cell: ({ row }) => <StatusBadge variant="neutral">{tStage(row.original.stage)}</StatusBadge> },
                { id: 'genre', header: t('columns.genre'), cell: ({ row }) => row.original.genre ?? '—' },
                { id: 'updated', header: t('columns.updated'), cell: ({ row }) => formatDate(row.original.updatedAt) },
            ]),
        [t, tStage, workspaceSlug],
    );

    const actions = (
            <div className="flex flex-wrap items-center gap-tight">
                <Link href={APP_ROUTES.series(workspaceSlug)} className={buttonVariants({ variant: 'secondary' })} id="series-library-link">
                    <Library className="size-4" aria-hidden="true" />
                    {tSources('seriesTitle')}
                </Link>
                {canManageDeleted ? (
                    <Link href={APP_ROUTES.deletedBooks(workspaceSlug)} className={buttonVariants({ variant: 'secondary' })} id="deleted-books-link">
                        <Trash2 className="size-4" aria-hidden="true" />
                        {t('recentlyDeleted')}
                    </Link>
                ) : null}
                {canEdit ? (
                    <Button variant="primary" icon={<Plus className="size-4" aria-hidden="true" />} onClick={() => setCreating(true)} id="create-book">
                        {t('create')}
                    </Button>
                ) : null}
            </div>
        );

    return (
        <EntityListPage<BookView>
            header={{
                title: t('title'),
                description: truncated
                    ? t('truncated', { count: books.length })
                    : books.length === 1
                      ? t('countOne')
                      : books.length > 1
                        ? t('count', { count: books.length })
                        : t('description'),
                actions,
            }}
            table={{
                data: books,
                columns,
                getRowId: (b) => b.id,
                onRowClick: (row) => router.push(APP_ROUTES.book(workspaceSlug, row.original.id)),
                selectionEnabled: false,
                emptyState: <EmptyState icon={Library} title={t('empty')} description={canEdit ? t('emptyHint') : undefined} />,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                'data-testid': 'books-table',
            }}
        >
            {canEdit ? <CreateBookModal open={creating} setOpen={setCreating} workspaceSlug={workspaceSlug} /> : null}
        </EntityListPage>
    );
}
