import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BooksList } from '@/components/bible/BooksList';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadBooksPage } from '@/app-layer/usecases/bible-pages';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('bible.meta');
    return { title: t('books') };
}

/**
 * The workspace's books (Phase 1.2). Read on the server through the 1.1
 * usecase; whether the viewer may create one is their permission set's
 * `bible.edit`, never a role name read in the browser.
 */
export default async function BooksPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
    const { workspaceSlug } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const { books, truncated } = await loadBooksPage(ctx);
    return (
        <BooksList
            workspaceSlug={ctx.workspaceSlug}
            books={books}
            truncated={truncated}
            canEdit={ctx.permissions.bible.edit}
            canManageDeleted={ctx.permissions.books.delete}
        />
    );
}
