import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FactsReview } from '@/components/sources/FactsReview';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { requireBookForPage } from '@/app-layer/usecases/source-pages';
import { listBookFacts } from '@/app-layer/usecases/source-facts';
import { orNotFound } from '@/lib/bible/page-data';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('sources.facts');
    return { title: t('title') };
}

/**
 * The facts a book's sources state (Phase 4.0, D23): each quoted with its
 * passage, confirmed or rejected by the author; only a confirmed one counts as
 * answered. A book the workspace does not hold is a 404.
 */
export default async function BookFactsPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const book = await orNotFound(requireBookForPage(ctx, bookId));
    const initial = await orNotFound(listBookFacts(ctx, bookId));
    return <FactsReview workspaceSlug={ctx.workspaceSlug} book={{ id: book.id, title: book.title }} initial={initial} canEdit={ctx.permissions.bible.edit} />;
}
