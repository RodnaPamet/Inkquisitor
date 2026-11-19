'use client';

/**
 * The workspace's books (Phase 1.2), on the lifted `<EntityListPage>`. A
 * row opens the book's home; an author who may edit gets the create button,
 * which opens `<CreateBookModal>`. Whether they may is the server's answer
 * (`bible.edit` on the page's context), passed in as `canEdit`.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Library, Plus } from 'lucide-react';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { Button } from '@/components/ui/button';
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
    canEdit: boolean;
}

export function BooksList({ workspaceSlug, books, canEdit }: BooksListProps) {
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

    const createButton = canEdit ? (
        <Button variant="primary" icon={<Plus className="size-4" aria-hidden="true" />} onClick={() => setCreating(true)} id="create-book">
            {t('create')}
        </Button>
    ) : null;

    return (
        <EntityListPage<BookView>
            header={{
                title: t('title'),
                description: books.length === 1 ? t('countOne') : books.length > 1 ? t('count', { count: books.length }) : t('description'),
                actions: createButton,
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
