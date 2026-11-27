'use client';

/**
 * A manuscript's Recently deleted scenes (Phase 5.H-a, issue #71), on the lifted `<EntityListPage>`: each scene
 * deleted in the last 30 days, its chapter, when it was deleted and until when it can be restored. Restore brings it
 * back with its text, note, card, links, history and research proposals — at its place, or at the end of its chapter
 * when that place is taken — and opens it; past the date the daily purge deletes it for good. Everyone who reads the
 * manuscript sees the list; restoring is for those who may edit it (`bible.edit`).
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
import { bibleFetch, reasonOf } from '@/lib/bible/api-client';
import { MANUSCRIPT_API, type DeletedSceneView } from '@/lib/manuscript/api-client';
import { SCENE_RESTORE_DAYS } from '@/lib/manuscript/scene-retention';
import { useManuscriptReason } from './messages';

export interface DeletedScenesListProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    scenes: DeletedSceneView[];
    truncated?: boolean;
    canEdit: boolean;
}

export function DeletedScenesList({ workspaceSlug, book, scenes, truncated = false, canEdit }: DeletedScenesListProps) {
    const t = useTranslations('manuscript.deletedScenes');
    const reasonText = useManuscriptReason();
    const router = useRouter();
    const [restoring, setRestoring] = useState<string | null>(null);

    const columns = useMemo(() => {
        const nameOf = (s: DeletedSceneView) => s.title ?? t('untitled');
        async function restore(s: DeletedSceneView) {
            setRestoring(s.id);
            try {
                const r = await bibleFetch<{ id: string; placement: 'ORIGINAL' | 'END_OF_CHAPTER' }>(MANUSCRIPT_API.restoreDeletedScene(workspaceSlug, book.id, s.id), { method: 'POST' });
                toast.success(r.placement === 'ORIGINAL' ? t('restored', { title: nameOf(s) }) : t('restoredAtEnd', { title: nameOf(s) }));
                router.push(APP_ROUTES.scene(workspaceSlug, book.id, r.id));
            } catch (err) {
                toast.error(reasonText(reasonOf(err)));
                setRestoring(null);
            }
        }
        return createColumns<DeletedSceneView>([
            { id: 'title', header: t('columns.title'), cell: ({ row }) => <span className="font-medium text-content-emphasis">{nameOf(row.original)}</span> },
            { id: 'chapter', header: t('columns.chapter'), cell: ({ row }) => row.original.chapterTitle ?? t('untitledChapter') },
            { id: 'words', header: t('columns.words'), cell: ({ row }) => t('words', { count: row.original.wordCount }) },
            { id: 'deleted', header: t('columns.deleted'), cell: ({ row }) => formatDate(row.original.deletedAt) },
            { id: 'until', header: t('columns.until'), cell: ({ row }) => formatDate(row.original.restorableUntil) },
            ...(canEdit
                ? [
                      {
                          id: 'restore',
                          header: t('columns.action'),
                          cell: ({ row }: { row: { original: DeletedSceneView } }) => (
                              <Button
                                  variant="secondary"
                                  size="sm"
                                  icon={<RotateCcw className="size-3.5" aria-hidden="true" />}
                                  loading={restoring === row.original.id}
                                  disabled={restoring !== null}
                                  onClick={() => void restore(row.original)}
                                  aria-label={t('restoreAria', { title: nameOf(row.original) })}
                                  data-testid={`restore-scene-${row.original.id}`}
                              >
                                  {t('restore')}
                              </Button>
                          ),
                      },
                  ]
                : []),
        ]);
    }, [t, workspaceSlug, book.id, router, reasonText, restoring, canEdit]);

    return (
        <EntityListPage<DeletedSceneView>
            header={{
                breadcrumbs: [{ label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) }, { label: t('breadcrumbManuscript'), href: APP_ROUTES.manuscript(workspaceSlug, book.id) }, { label: t('title') }],
                title: t('title'),
                description: truncated ? t('truncated', { count: scenes.length, days: SCENE_RESTORE_DAYS }) : t('description', { days: SCENE_RESTORE_DAYS }),
            }}
            table={{
                data: scenes,
                columns,
                getRowId: (s) => s.id,
                selectionEnabled: false,
                emptyState: <EmptyState icon={Trash2} title={t('empty')} description={t('emptyHint', { days: SCENE_RESTORE_DAYS })} />,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                'data-testid': 'deleted-scenes-table',
            }}
        />
    );
}
