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
 *
 * Rich text is proved before it goes in (issue #45, item 3; Phase 3.H). A
 * stored note's `richText` is a TipTap document read back from storage;
 * tldraw's validator checks its outline, not its nodes, so a node the schema
 * does not hold, or an empty text node, passes it and throws only when the
 * note is rendered or measured — in geometry, outside tldraw's per-shape
 * error boundary. Each `richText` prop is rendered once here: one that cannot
 * be keeps its words as plain text (`toRichText`), and a shape whose geometry
 * still throws once created is taken out again, so one bad record never takes
 * the map down. The plain text is what the author wrote; only its formatting
 * is lost.
 */
import { renderHtmlFromRichText, toRichText, type Editor, type TLRichText, type TLShapeId } from 'tldraw';

import type { FreeformRecord } from './serializer';

/** Every text leaf of a rich-text document, a line per block, whatever node names it uses. */
function plainTextOf(node: unknown): string {
    if (typeof node !== 'object' || node === null) return '';
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') return n.text;
    if (!Array.isArray(n.content)) return '';
    const parts = n.content.map(plainTextOf);
    const isBlock = n.content.some((c) => typeof c === 'object' && c !== null && Array.isArray((c as { content?: unknown }).content));
    return parts.join(isBlock ? '\n' : '');
}

/** `props` with every `richText` that cannot be rendered replaced by its words as plain rich text. */
function renderableProps(editor: Editor, props: unknown): unknown {
    if (typeof props !== 'object' || props === null || !('richText' in props)) return props;
    const richText = (props as { richText: unknown }).richText;
    try {
        renderHtmlFromRichText(editor, richText as TLRichText);
        return props;
    } catch {
        return { ...(props as Record<string, unknown>), richText: toRichText(plainTextOf(richText)) };
    }
}

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
            const record = { ...r, props: renderableProps(editor, (r as { props?: unknown }).props) };
            editor.createShapes([record as unknown as Parameters<Editor['createShapes']>[0][number]]);
            try {
                editor.getShapeGeometry(r.id as TLShapeId);
            } catch {
                editor.deleteShapes([r.id as TLShapeId]);
                return;
            }
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
