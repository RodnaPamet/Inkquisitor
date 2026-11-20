import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InterviewsList } from '@/components/interview/InterviewsList';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadInterviewsPage } from '@/app-layer/usecases/interview-pages';
import { orNotFound } from '@/lib/bible/page-data';
import { kindLabels } from '@/lib/interview/page-model';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('interview.meta');
    return { title: t('list') };
}

/**
 * A book's interviews (Phase 2.4): each with what it asked about, its status
 * and why it stopped; open one to resume it. `bible.view`.
 */
export default async function InterviewsPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const { book, sessions, truncated, pendingBySession } = await orNotFound(loadInterviewsPage(ctx, bookId));
    return (
        <InterviewsList
            workspaceSlug={ctx.workspaceSlug}
            book={{ id: book.id, title: book.title }}
            sessions={sessions}
            truncated={truncated}
            kindLabels={kindLabels()}
            pendingBySession={pendingBySession}
        />
    );
}
