import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FactsReview } from '@/components/sources/FactsReview';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { requireBookForPage } from '@/app-layer/usecases/source-pages';
import { listBookFacts } from '@/app-layer/usecases/source-facts';
import { listFactProposals } from '@/app-layer/usecases/fact-proposals';
import { orNotFound } from '@/lib/bible/page-data';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('sources.facts');
    return { title: t('title') };
}

/**
 * The facts a book's sources state (Phase 4.0, D23): each quoted with its
 * passage, confirmed or rejected by the author; only a confirmed one counts as
 * answered. The possible contradictions (4.1) are decided on the Continuity page
 * (4.2), which this page links to while any wait. A book the workspace does not hold is a 404.
 */
export default async function BookFactsPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const book = await orNotFound(requireBookForPage(ctx, bookId));
    const initial = await orNotFound(listBookFacts(ctx, bookId));
    // Phase 4.2 (D28): the proposals to invalidate a fact are decided on the Continuity page; this page links there.
    const proposals = await orNotFound(listFactProposals(ctx, bookId));
    return <FactsReview workspaceSlug={ctx.workspaceSlug} book={{ id: book.id, title: book.title }} initial={initial} canEdit={ctx.permissions.bible.edit} pendingContinuity={proposals.pending} />;
}
