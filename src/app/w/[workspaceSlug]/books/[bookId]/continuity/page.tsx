import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ContinuityPage } from '@/components/continuity/ContinuityPage';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { getContinuityPage } from '@/app-layer/usecases/continuity';
import { requireBookForPage } from '@/app-layer/usecases/source-pages';
import { orNotFound } from '@/lib/bible/page-data';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('continuity');
    return { title: t('title') };
}

/**
 * A book's Continuity page (Phase 4.2, D28): its contradictions with both
 * sources, its promises, clues and open questions, and the entries that may be
 * stale, each decided by the author. A book the workspace does not hold is a 404.
 */
export default async function BookContinuityPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const book = await orNotFound(requireBookForPage(ctx, bookId));
    const initial = await orNotFound(getContinuityPage(ctx, bookId));
    return <ContinuityPage workspaceSlug={ctx.workspaceSlug} book={{ id: book.id, title: book.title }} initial={initial} canEdit={ctx.permissions.bible.edit} />;
}
