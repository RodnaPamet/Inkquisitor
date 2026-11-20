/**
 * A saved story map (Phase 3.1), through the real usecase: the map row, a
 * node per seeded element, the seeded relation as an edge, a sticky note and
 * the save's snapshot — a row in every canvas table.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { saveStoryMap } from '@/app-layer/usecases/story-maps';
import type { SeededBible } from './bible';

export async function seedStoryMap(ctx: WorkspaceRequestContext, book: SeededBible, marker = 'seed') {
    return saveStoryMap(ctx, book.bookId, 'relationship', {
        expectedVersion: 0,
        nodes: [
            { elementId: book.characterId, x: 0, y: 0, w: 220, h: 88, lane: null },
            { elementId: book.factionId, x: 400, y: 0, w: 220, h: 88, lane: null },
        ],
        edges: [{ relationId: book.relationId, sourceElementId: book.characterId, targetElementId: book.factionId }],
        freeform: [{ id: 'shape:seed-note', typeName: 'shape', type: 'note', x: 0, y: 200, props: { text: `Note ${marker}` } }],
    });
}
