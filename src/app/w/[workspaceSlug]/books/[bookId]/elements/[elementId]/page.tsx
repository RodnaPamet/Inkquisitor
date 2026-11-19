import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ElementPage } from '@/components/bible/ElementPage';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { loadElementPage, VERSION_PAGE_SIZE } from '@/app-layer/usecases/bible-pages';
import { orNotFound } from '@/lib/bible/page-data';
import { fieldDefsFor, kindSummaries, relationOptionsFor } from '@/lib/bible/ui-model';
import type { BibleKind } from '@/lib/bible/kinds';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('bible.meta');
    return { title: t('element') };
}

/**
 * One bible element (Phase 1.2). Everything the page needs is read here
 * through `loadElementPage` — the book, the element with its fields and
 * relations, the first page of versions — and the kind's template is handed
 * over as plain data. The relation picker searches the book on demand. An
 * element the book does not hold (or of a deleted book) is a 404.
 */
export default async function BibleElementPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string; elementId: string }> }) {
    const { workspaceSlug, bookId, elementId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const { book, element, versions } = await orNotFound(loadElementPage(ctx, bookId, elementId));
    const kindLabels = Object.fromEntries(kindSummaries().map((k) => [k.kind, k.label])) as Record<BibleKind, string>;
    return (
        <ElementPage
            workspaceSlug={ctx.workspaceSlug}
            book={{ id: book.id, title: book.title }}
            element={element}
            fieldDefs={fieldDefsFor(element.kind)}
            kindLabels={kindLabels}
            relationOptions={relationOptionsFor(element.kind)}
            initialVersions={versions}
            versionPageSize={VERSION_PAGE_SIZE}
            canEdit={ctx.permissions.bible.edit}
        />
    );
}
