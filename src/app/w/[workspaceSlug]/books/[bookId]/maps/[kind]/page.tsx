import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { StoryMapWorkspace } from '@/components/canvas/StoryMapWorkspace';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadStoryMapPage } from '@/app-layer/usecases/story-maps';
import { orNotFound } from '@/lib/bible/page-data';
import { kindSummaries } from '@/lib/bible/ui-model';
import { mapKindFromSlug } from '@/lib/canvas/map-kinds';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ kind: string }> }): Promise<Metadata> {
    const { kind } = await params;
    const t = await getTranslations('canvas');
    const value = mapKindFromSlug(kind);
    return { title: value ? t(`kinds.${value}`) : undefined };
}

/**
 * One of a book's story maps (Phase 3.1, decision D18: the relationship map,
 * the plot board, the timeline). The canvas is loaded in the browser only,
 * behind an error boundary (`StoryMapWorkspace`). A book the workspace does
 * not hold, or a kind that is not a map, is a 404. `canEdit` is
 * `bible.edit`; a reader sees the map read-only.
 */
export default async function StoryMapPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string; kind: string }> }) {
    const { workspaceSlug, bookId, kind } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const data = await orNotFound(loadStoryMapPage(ctx, bookId, kind));
    const kinds = kindSummaries();
    return (
        <StoryMapWorkspace
            workspaceSlug={ctx.workspaceSlug}
            book={data.book}
            kind={data.kind}
            kindSlug={kind}
            initialMap={data.map}
            kindLabels={Object.fromEntries(kinds.map((k) => [k.kind, k.label]))}
            fieldCounts={Object.fromEntries(kinds.map((k) => [k.kind, k.fieldCount]))}
            canEdit={ctx.permissions.bible.edit}
        />
    );
}
