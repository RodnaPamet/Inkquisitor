/**
 * The freeform layer, restored into an editor.
 *
 * Carved from inflect-compliance's `restoreFreeform` in
 * `TldrawProcessCanvas.tsx` (docs/carve-manifest.md). Notes, text, drawings,
 * frames and loose arrows were saved as the tldraw records they were.
 * Shapes go in parents-first (a note inside a frame needs its frame), then
 * bindings. A record tldraw refuses is skipped rather than allowed to take
 * the whole map down; one whose parent is a page moves to this editor's page.
 *
 * A record whose id is already in the store is skipped. The rows are seeded
 * first, and tldraw's create APIs PUT (a second record with an id replaces the
 * first): a freeform record named like a node (`shape:<elementId>`), an edge
 * line or an edge binding would otherwise replace it, the node would vanish
 * from the next save and the edges bound to it would make every save throw.
 */
import type { Editor } from 'tldraw';

import type { FreeformRecord } from './serializer';

export function restoreFreeform(editor: Editor, freeform: readonly FreeformRecord[]): number {
    if (freeform.length === 0) return 0;
    const pageId = editor.getCurrentPageId();
    const fresh = freeform.filter((r) => !editor.store.has(r.id as Parameters<Editor['store']['has']>[0]));
    const shapes = fresh.filter((r) => r.typeName === 'shape');
    const bindings = fresh.filter((r) => r.typeName === 'binding');
    const placed = new Set<string>();
    let restored = 0;
    let pending = shapes.map((r) => {
        const parentId = typeof r.parentId === 'string' ? r.parentId : pageId;
        return { ...r, parentId: parentId.startsWith('page:') ? pageId : parentId };
    });
    const tryCreate = (r: (typeof pending)[number]) => {
        try {
            editor.createShapes([r as unknown as Parameters<Editor['createShapes']>[0][number]]);
            placed.add(r.id);
            restored += 1;
        } catch {
            // Unrestorable record: what tldraw cannot validate it could not show either.
        }
    };
    for (let pass = 0; pending.length > 0 && pass < 20; pass++) {
        const ready = pending.filter((r) => r.parentId === pageId || placed.has(r.parentId));
        if (ready.length === 0) break;
        ready.forEach(tryCreate);
        pending = pending.filter((r) => !ready.includes(r));
    }
    // A shape whose parent never arrived keeps its place on the page.
    pending.forEach((r) => tryCreate({ ...r, parentId: pageId }));
    for (const b of bindings) {
        try {
            editor.createBindings([b as unknown as Parameters<Editor['createBindings']>[0][number]]);
            restored += 1;
        } catch {
            // A binding to a shape that was not restored.
        }
    }
    return restored;
}
