import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { InterviewSession } from '@/components/interview/InterviewSession';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadNewInterviewPage } from '@/app-layer/usecases/interview-pages';
import { APP_ROUTES } from '@/lib/app-routes';
import { orNotFound } from '@/lib/bible/page-data';
import { setupFromQuery } from '@/lib/interview/setup';
import { fieldLabelsFor, kindLabels } from '@/lib/interview/page-model';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('interview.meta');
    return { title: t('new') };
}

/**
 * A new interview (Phase 2.4), started on this page with the setup the sheet
 * put in the query (`interviewSetupQuery`): the first round streams in here,
 * and the address becomes the session's own as soon as it exists. A query
 * that names no interview, or a viewer who may not run one (`bible.edit`), is
 * sent to the book's interviews.
 */
export default async function NewInterviewPage({
    params,
    searchParams,
}: {
    params: Promise<{ workspaceSlug: string; bookId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const parsed = setupFromQuery(await searchParams);
    if (!parsed || !ctx.permissions.bible.edit) redirect(APP_ROUTES.interviews(ctx.workspaceSlug, bookId));
    const { book, elements } = await orNotFound(loadNewInterviewPage(ctx, bookId, parsed.target));
    return (
        <InterviewSession
            workspaceSlug={ctx.workspaceSlug}
            book={{ id: book.id, title: book.title }}
            canEdit
            elements={elements}
            fieldLabels={fieldLabelsFor(elements.map((e) => e.kind))}
            kindLabels={kindLabels()}
            initial={{ kind: 'start', target: parsed.target, setup: parsed.setup }}
        />
    );
}
