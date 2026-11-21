import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SourcesPage } from '@/components/sources/SourcesPage';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { listSeriesSources } from '@/app-layer/usecases/source-library';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('sources');
    return { title: t('seriesTitle') };
}

/** The workspace's series library (Phase 4.0, D26): sources shared across the author's books, each opted into per book. */
export default async function SeriesLibraryPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
    const { workspaceSlug } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const listing = await listSeriesSources(ctx);
    return <SourcesPage workspaceSlug={ctx.workspaceSlug} book={null} sources={listing.sources} canEdit={ctx.permissions.bible.edit} />;
}
