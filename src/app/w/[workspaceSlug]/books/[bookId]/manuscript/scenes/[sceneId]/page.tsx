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
export default async function ScenePage({
    params,
    searchParams,
}: {
    params: Promise<{ workspaceSlug: string; bookId: string; sceneId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { workspaceSlug, bookId, sceneId } = await params;
    const openAt = openAtOf(await searchParams);
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
            openAt={openAt}
        />
    );
}

/** Phase 5.H-a: `?at=<offset>&len=<n>` (a word-search result): two bounded integers, else nothing. */
function openAtOf(sp: Record<string, string | string[] | undefined>): { start: number; length: number } | null {
    const one = (v: string | string[] | undefined) => (typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null);
    const start = one(sp.at);
    const length = one(sp.len);
    return start === null ? null : { start, length: Math.min(length ?? 1, 10_000) };
}
