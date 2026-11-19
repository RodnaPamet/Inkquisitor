/**
 * Integration fixtures for the bible: a book with elements, fields, a
 * relation and their versions, written through the product's own usecases (so
 * every row is sanitised, encrypted and versioned exactly as a request would
 * leave it). Text that should stay private carries a recognisable marker, so
 * a suite can look for it in the raw rows.
 */
import { createBook } from '@/app-layer/usecases/books';
import { addRelation } from '@/app-layer/usecases/bible-relations';
import { createElement } from '@/app-layer/usecases/bible-elements';
import type { WorkspaceRequestContext } from '@/app-layer/types';

export interface SeededBible {
    bookId: string;
    characterId: string;
    factionId: string;
    relationId: string;
}

/** A book with a CHARACTER (two fields), a FACTION and a `member_of` relation between them. */
export async function seedBible(ctx: WorkspaceRequestContext, marker = 'seed'): Promise<SeededBible> {
    const book = await createBook(ctx, { title: `Book ${marker}`, logline: `Logline ${marker}`, stage: 'PLANNING' });
    const character = await createElement(ctx, book.id, {
        kind: 'CHARACTER',
        name: `Mara ${marker}`,
        summary: `Summary ${marker}`,
        fields: [
            { key: 'role', value: `Role ${marker}` },
            { key: 'want', value: `Want ${marker}` },
        ],
        changeSummary: `First draft ${marker}`,
    });
    const faction = await createElement(ctx, book.id, { kind: 'FACTION', name: `Salt Guild ${marker}` });
    const relation = await addRelation(ctx, book.id, {
        fromElementId: character.id,
        toElementId: faction.id,
        type: 'member_of',
        note: `Note ${marker}`,
    });
    return { bookId: book.id, characterId: character.id, factionId: faction.id, relationId: relation.id };
}
