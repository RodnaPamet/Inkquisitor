import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ResearchPage } from '@/components/research/ResearchPage';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadResearchPage } from '@/app-layer/usecases/research-pages';
import { orNotFound } from '@/lib/bible/page-data';
import { kindLabels } from '@/lib/interview/page-model';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('research.meta');
    return { title: t('title') };
}

/**
 * A book's Research page (Phase 2.6, decision D9): write a brief, run it, read
 * the cited findings and review the proposed bible changes. A book the
 * workspace does not hold is a 404. `canEdit` is `bible.edit`; a reader reads.
 */
export default async function BookResearchPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const data = await orNotFound(loadResearchPage(ctx, bookId));
    return (
        <ResearchPage
            workspaceSlug={ctx.workspaceSlug}
            book={{ id: data.book.id, title: data.book.title }}
            briefs={data.briefs}
            truncated={data.truncated}
            elements={data.elements}
            kindLabels={kindLabels()}
            canEdit={ctx.permissions.bible.edit}
            initialReview={data.initialReview}
        />
    );
}
