import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ElementPage } from '@/components/bible/ElementPage';
import { getWorkspacePageCtx } from '@/app-layer/context';
import { getElement, listElements } from '@/app-layer/usecases/bible-elements';
import { listVersions } from '@/app-layer/usecases/bible-versions';
import { getBook } from '@/app-layer/usecases/books';
import { orNotFound } from '@/lib/bible/page-data';
import { fieldDefsFor, kindSummaries, relationOptionsFor } from '@/lib/bible/ui-model';
import type { BibleKind } from '@/lib/bible/kinds';

export const dynamic = 'force-dynamic';

/** Versions read per page of the History tab. */
const VERSION_PAGE_SIZE = 50;

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('bible.meta');
    return { title: t('element') };
}

/**
 * One bible element (Phase 1.2). Everything the page needs is read here
 * through the 1.1 usecases — the book, the element with its fields and
 * relations, the book's other elements (the relation picker), the first page
 * of versions — and the kind's template is handed over as plain data. An
 * element the book does not hold is a 404.
 */
export default async function BibleElementPage({ params }: { params: Promise<{ workspaceSlug: string; bookId: string; elementId: string }> }) {
    const { workspaceSlug, bookId, elementId } = await params;
    const { ctx } = await getWorkspacePageCtx(workspaceSlug);
    const [book, element, elements, versions] = await orNotFound(
        Promise.all([
            getBook(ctx, bookId),
            getElement(ctx, bookId, elementId),
            listElements(ctx, bookId),
            listVersions(ctx, bookId, elementId, { take: VERSION_PAGE_SIZE }),
        ]),
    );
    const kindLabels = Object.fromEntries(kindSummaries().map((k) => [k.kind, k.label])) as Record<BibleKind, string>;
    return (
        <ElementPage
            workspaceSlug={ctx.workspaceSlug}
            book={{ id: book.id, title: book.title }}
            element={element}
            fieldDefs={fieldDefsFor(element.kind)}
            kindLabels={kindLabels}
            relationOptions={relationOptionsFor(element.kind)}
            bookElements={elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind }))}
            initialVersions={versions}
            versionPageSize={VERSION_PAGE_SIZE}
            canEdit={ctx.permissions.bible.edit}
        />
    );
}
