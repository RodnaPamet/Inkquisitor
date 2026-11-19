import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BookBoard } from '@/components/bible/BookBoard';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { listElements } from '@/app-layer/usecases/bible-elements';
import { getBook } from '@/app-layer/usecases/books';
import { orNotFound } from '@/lib/bible/page-data';
import { kindSummaries } from '@/lib/bible/ui-model';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('bible.meta');
    return { title: t('book') };
}

/**
 * A book's home (Phase 1.2): the board of element kinds. The book and its
 * elements (with how many template fields each has filled) come from the 1.1
 * usecases; the kinds and their field counts from the template registry. A
 * book the workspace does not hold is a 404.
 */
export default async function BookPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const [book, elements] = await orNotFound(Promise.all([getBook(ctx, bookId), listElements(ctx, bookId)]));
    return <BookBoard workspaceSlug={ctx.workspaceSlug} book={book} kinds={kindSummaries()} elements={elements} canEdit={ctx.permissions.bible.edit} />;
}
