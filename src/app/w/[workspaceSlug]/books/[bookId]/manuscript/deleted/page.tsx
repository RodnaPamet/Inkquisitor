import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DeletedScenesList } from '@/components/manuscript/DeletedScenesList';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadDeletedScenesPage } from '@/app-layer/usecases/manuscript-pages';
import { orNotFound } from '@/lib/bible/page-data';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('manuscript.meta');
    return { title: t('deletedScenes') };
}

/**
 * A manuscript's Recently deleted scenes (Phase 5.H-a, issue #71): those deleted in the last 30 days, each restorable
 * until the date shown. Every reader sees the list; `canEdit` (`bible.edit`) restores. A book the workspace does not
 * hold is a 404.
 */
export default async function DeletedScenesPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const data = await orNotFound(loadDeletedScenesPage(ctx, bookId));
    return <DeletedScenesList workspaceSlug={ctx.workspaceSlug} book={{ id: data.book.id, title: data.book.title }} scenes={data.scenes} truncated={data.truncated} canEdit={ctx.permissions.bible.edit} />;
}
