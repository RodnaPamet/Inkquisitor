import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InterviewSession } from '@/components/interview/InterviewSession';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadInterviewPage } from '@/app-layer/usecases/interview-pages';
import { orNotFound } from '@/lib/bible/page-data';
import { fieldLabelsFor, kindLabels } from '@/lib/interview/page-model';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('interview.meta');
    return { title: t('session') };
}

/**
 * One interview (Phase 2.4), as stored: resume it where it was left. An
 * interview the book does not hold is a 404. `canEdit` is `bible.edit`; a
 * reader sees the questions and answers as text.
 */
export default async function InterviewPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string; sessionId: string }> }) {
    const { workspaceSlug, bookId, sessionId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const { book, interview, elements } = await orNotFound(loadInterviewPage(ctx, bookId, sessionId));
    return (
        <InterviewSession
            key={interview.session.id}
            workspaceSlug={ctx.workspaceSlug}
            book={{ id: book.id, title: book.title }}
            canEdit={ctx.permissions.bible.edit}
            elements={elements}
            fieldLabels={fieldLabelsFor(elements.map((e) => e.kind))}
            kindLabels={kindLabels()}
            initial={{ kind: 'existing', interview }}
        />
    );
}
