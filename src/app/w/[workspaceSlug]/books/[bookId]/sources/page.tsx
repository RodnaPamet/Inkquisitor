import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SourcesPage } from '@/components/sources/SourcesPage';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { requireBookForPage } from '@/app-layer/usecases/source-pages';
import { listBookSources } from '@/app-layer/usecases/source-library';
import { orNotFound } from '@/lib/bible/page-data';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('sources');
    return { title: t('title') };
}

/**
 * A book's Sources page (Phase 4.0, D23, D26): upload drafts, notes and earlier
 * books, see each one's cost before reading its facts, and choose the series
 * sources the book draws on. A book the workspace does not hold is a 404.
 */
export default async function BookSourcesPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const book = await orNotFound(requireBookForPage(ctx, bookId));
    const listing = await orNotFound(listBookSources(ctx, bookId));
    return <SourcesPage workspaceSlug={ctx.workspaceSlug} book={{ id: book.id, title: book.title }} sources={listing.sources} series={listing.series ?? []} canEdit={ctx.permissions.bible.edit} />;
}
