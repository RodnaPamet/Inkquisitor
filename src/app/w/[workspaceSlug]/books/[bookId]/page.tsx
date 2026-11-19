import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BookBoard } from '@/components/bible/BookBoard';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadBookPage } from '@/app-layer/usecases/bible-pages';
import { orNotFound } from '@/lib/bible/page-data';
import { kindSummaries } from '@/lib/bible/ui-model';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('bible.meta');
    return { title: t('book') };
}

/**
 * A book's home (Phase 1.2): the board of element kinds. The book and its
 * board (per kind: counts and filled fields by aggregate, the first entries)
 * come from `loadBookPage`; the kinds and their field counts from the
 * template registry. A book the workspace does not hold, or a deleted one, is
 * a 404.
 */
export default async function BookPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const { book, board } = await orNotFound(loadBookPage(ctx, bookId));
    return (
        <BookBoard
            workspaceSlug={ctx.workspaceSlug}
            book={book}
            kinds={kindSummaries()}
            board={board}
            canEdit={ctx.permissions.bible.edit}
            canDeleteBook={ctx.permissions.books.delete}
        />
    );
}
