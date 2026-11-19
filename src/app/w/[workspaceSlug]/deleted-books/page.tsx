import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { DeletedBooksList } from '@/components/bible/DeletedBooksList';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { listDeletedBooks } from '@/app-layer/usecases/books';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('bible.meta');
    return { title: t('deletedBooks') };
}

/**
 * The workspace's recently deleted books (Phase 1.H): those deleted in the
 * last 30 days, each restorable until the date shown. The OWNER's alone
 * (`books.delete`); anyone else gets the 404 a missing page gets, without the
 * usecase's audited refusal for merely following a link.
 */
export default async function DeletedBooksPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
    const { workspaceSlug } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    if (!ctx.permissions.books.delete) notFound();
    const { books, truncated } = await listDeletedBooks(ctx);
    return <DeletedBooksList workspaceSlug={ctx.workspaceSlug} books={books} truncated={truncated} />;
}
