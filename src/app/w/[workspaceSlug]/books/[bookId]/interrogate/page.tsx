import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InterrogatePage } from '@/components/interrogation/InterrogatePage';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { getGapHuntPage } from '@/app-layer/usecases/gap-hunts';
import { requireBookForPage } from '@/app-layer/usecases/source-pages';
import { getStressTestPage } from '@/app-layer/usecases/stress-tests';
import { orNotFound } from '@/lib/bible/page-data';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('interrogation');
    return { title: t('title') };
}

/**
 * A book's Interrogate page (Phase 4.3, D29): the stress test, the gap hunt
 * and the persona panel, each questioning the whole book. Nothing here writes
 * the bible. A book the workspace does not hold is a 404.
 */
export default async function BookInterrogatePage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string }> }) {
    const { workspaceSlug, bookId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const book = await orNotFound(requireBookForPage(ctx, bookId));
    const stress = await orNotFound(getStressTestPage(ctx, bookId));
    const gaps = await orNotFound(getGapHuntPage(ctx, bookId));
    return <InterrogatePage workspaceSlug={ctx.workspaceSlug} book={{ id: book.id, title: book.title }} stress={stress} gaps={gaps} canEdit={ctx.permissions.bible.edit} />;
}
