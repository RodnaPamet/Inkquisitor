import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ManuscriptPage } from '@/components/manuscript/ManuscriptPage';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadManuscriptPage } from '@/app-layer/usecases/manuscript-pages';
import { orNotFound } from '@/lib/bible/page-data';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('manuscript.meta');
    return { title: t('title') };
}

/**
 * A book's manuscript (Phase 5.1, D33): the outline of parts, chapters and
 * scenes, with word counts, and the import. A book the workspace does not hold
 * is a 404. `canEdit` is `bible.edit`; a reader reads.
 */
export default async function BookManuscriptPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const data = await orNotFound(loadManuscriptPage(ctx, bookId));
    return <ManuscriptPage workspaceSlug={ctx.workspaceSlug} book={{ id: data.book.id, title: data.book.title }} initial={data.outline} canEdit={ctx.permissions.bible.edit} />;
}
