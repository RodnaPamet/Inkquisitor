/**
 * Does the book already hold an element of this name? (Phase 2.5.)
 *
 * A proposed new element is refused when the book holds one of the same name
 * (`ELEMENT_EXISTS`), compared by `nameKey`: without case, look-alike letters,
 * format characters or a leading article ("The Drainage Board" is "Drainage
 * Board"). That comparison cannot be pushed into the database: an ILIKE on
 * the proposed name misses "Drainage Board" when the proposal says "The
 * Drainage Board", and misses a name spelled with a look-alike letter. So the
 * book's element names are read here, a keyset page at a time (list columns
 * only: nothing is decrypted), and compared in code. Every page is bounded;
 * the walk ends at the book's last element.
 *
 * Read by the reconcile run when it stores a new-element proposal and by the
 * acceptance that creates one, both inside their own transaction.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { nameKey } from '@/lib/enrichment/validate';

/** Element names read per page. */
const NAMES_PAGE = 500;

/** True when an element of the book has the same name key as `name` (`exceptElementId` is not counted). */
export async function bookHoldsElementName(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, name: string, exceptElementId?: string): Promise<boolean> {
    const key = nameKey(name);
    if (key === '') return false;
    let after: { name: string; id: string } | undefined;
    for (;;) {
        const page = await BibleElementRepository.page(db, ctx.workspaceId, bookId, { after, take: NAMES_PAGE });
        if (page.some((e) => e.id !== exceptElementId && nameKey(e.name) === key)) return true;
        if (page.length < NAMES_PAGE) return false;
        const last = page[page.length - 1];
        after = { name: last.name, id: last.id };
    }
}
