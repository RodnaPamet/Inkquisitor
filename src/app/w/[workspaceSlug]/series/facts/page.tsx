import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FactsReview } from '@/components/sources/FactsReview';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { listSeriesFacts } from '@/app-layer/usecases/source-facts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('sources.facts');
    return { title: t('seriesTitle') };
}

/** The series library's facts (Phase 4.0, D26), confirmed once for every book that draws on them. */
export default async function SeriesFactsPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
    const { workspaceSlug } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const initial = await listSeriesFacts(ctx);
    return <FactsReview workspaceSlug={ctx.workspaceSlug} book={null} initial={initial} canEdit={ctx.permissions.bible.edit} />;
}
