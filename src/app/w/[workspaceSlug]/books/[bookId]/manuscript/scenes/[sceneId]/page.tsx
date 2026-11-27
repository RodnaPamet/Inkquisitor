import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SceneEditorPage } from '@/components/manuscript/SceneEditorPage';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadScenePage } from '@/app-layer/usecases/manuscript-pages';
import { orNotFound } from '@/lib/bible/page-data';
import { kindLabels } from '@/lib/interview/page-model';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('manuscript.meta');
    return { title: t('scene') };
}

/**
 * One scene's editor (Phase 5.1, D33): the prose, its details, linked elements,
 * note and history. A scene or book the workspace does not hold is a 404.
 */
export default async function ScenePage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string; sceneId: string }> }) {
    const { workspaceSlug, bookId, sceneId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const data = await orNotFound(loadScenePage(ctx, bookId, sceneId));
    return (
        <SceneEditorPage
            key={sceneId}
            workspaceSlug={ctx.workspaceSlug}
            book={{ id: data.book.id, title: data.book.title }}
            initial={data.scene}
            canEdit={ctx.permissions.bible.edit}
            kindLabels={kindLabels()}
        />
    );
}
