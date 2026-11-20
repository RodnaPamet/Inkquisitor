import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SessionReview } from '@/components/enrichment/SessionReview';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadReviewPage } from '@/app-layer/usecases/interview-pages';
import { orNotFound } from '@/lib/bible/page-data';
import { kindLabels } from '@/lib/interview/page-model';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('interview.meta');
    return { title: t('review') };
}

/**
 * One interview's proposed bible changes (Phase 2.5): each change against the
 * field as it stands now, with the answers it is drawn from; accept, edit then
 * accept, or reject. An interview the book does not hold is a 404. `canEdit`
 * is `bible.edit`; a reader sees the proposals as text.
 */
export default async function InterviewReviewPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string; sessionId: string }> }) {
    const { workspaceSlug, bookId, sessionId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const { book, review } = await orNotFound(loadReviewPage(ctx, bookId, sessionId));
    const t = await getTranslations('interview.meta');
    return (
        <SessionReview
            workspaceSlug={ctx.workspaceSlug}
            book={{ id: book.id, title: book.title }}
            review={review}
            canEdit={ctx.permissions.bible.edit}
            kindLabels={kindLabels()}
            interviewTitle={t('session')}
        />
    );
}
