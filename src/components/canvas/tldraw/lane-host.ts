/**
 * The derived maps' side of the canvas (Phase 3.2, decision D22): the plot
 * board and the timeline, where a card's place is the bible's.
 *
 *   installCardDrop    a card the author drags and lets go is reported to
 *                      the host (its centre), which turns it into an ORDER
 *                      MOVE in the bible (`dropTarget`, `src/lib/canvas/lanes.ts`)
 *   placeCards         every card put where the layout says, as a REMOTE
 *                      change: not an edit, not on the undo stack, never
 *                      autosaved (the store listener hears only the user's)
 *   showNodes          refresh what cards SHOW (name, badge, second line)
 *                      after the bible changed, the same way
 *
 * A dragged card is never stored where it was dropped: the move goes to the
 * bible and the card goes back to the place the bible then gives it.
 */
import type { Editor, TLShapeId } from 'tldraw';

import type { NodePlacement } from '@/lib/canvas/lanes';
import type { NodeDisplay } from './serializer';
import { STORY_NODE_SHAPE_TYPE, type StoryNodeShape } from './story-node-shape';

function storyNodes(editor: Editor): StoryNodeShape[] {
    return editor.getCurrentPageShapes().filter((s): s is StoryNodeShape => s.type === STORY_NODE_SHAPE_TYPE);
}

/**
 * Report cards the author moved, once the gesture ends (a drag reports one
 * change per frame; the pointer coming up, or a keyboard nudge completing, is
 * the drop). Only the user's changes: `placeCards` is remote. Returns a disposer.
 */
export function installCardDrop(editor: Editor, onDrop: (drops: Array<{ elementId: string; center: { x: number; y: number } }>) => void): () => void {
    const moved = new Set<TLShapeId>();
    const offChange = editor.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
        if (source !== 'user' || next.type !== STORY_NODE_SHAPE_TYPE) return;
        if (prev.x !== next.x || prev.y !== next.y) moved.add(next.id);
    });
    const offComplete = editor.sideEffects.registerOperationCompleteHandler(() => {
        if (moved.size === 0 || editor.inputs.isPointing) return;
        const ids = [...moved];
        moved.clear();
        const drops = ids.flatMap((id) => {
            const shape = editor.getShape(id) as StoryNodeShape | undefined;
            const bounds = editor.getShapePageBounds(id);
            return shape && bounds ? [{ elementId: shape.props.elementId, center: { x: bounds.center.x, y: bounds.center.y } }] : [];
        });
        if (drops.length > 0) onDrop(drops);
    });
    return () => {
        offChange();
        offComplete();
        moved.clear();
    };
}

/** Put every card the layout places where it says (a remote change: no edit, no undo step). */
export function placeCards(editor: Editor, positions: ReadonlyMap<string, NodePlacement>): void {
    const updates = storyNodes(editor).flatMap((s) => {
        const at = positions.get(s.props.elementId);
        if (!at) return [];
        if (s.x === at.x && s.y === at.y && s.props.w === at.w && s.props.h === at.h && s.props.lane === at.lane && String(s.parentId).startsWith('page:')) return [];
        return [{ id: s.id, type: STORY_NODE_SHAPE_TYPE, parentId: editor.getCurrentPageId(), x: at.x, y: at.y, props: { w: at.w, h: at.h, lane: at.lane } }];
    });
    if (updates.length === 0) return;
    editor.store.mergeRemoteChanges(() => {
        editor.updateShapes(updates as never);
    });
}

/** Refresh what cards show from the bible (a remote change). Edge labels follow their relation. */
export function showNodes(editor: Editor, shown: ReadonlyMap<string, NodeDisplay>): void {
    const updates = storyNodes(editor).flatMap((s) => {
        const d = shown.get(s.props.elementId);
        if (!d) return [];
        const detail = d.detail ?? '';
        if (s.props.name === d.name && s.props.kindLabel === d.kindLabel && s.props.badgeLabel === d.badgeLabel && s.props.badgeTone === d.badgeTone && s.props.detail === detail) return [];
        return [{ id: s.id, type: STORY_NODE_SHAPE_TYPE, props: { name: d.name, kindLabel: d.kindLabel, badgeLabel: d.badgeLabel, badgeTone: d.badgeTone, detail } }];
    });
    if (updates.length === 0) return;
    editor.store.mergeRemoteChanges(() => {
        editor.updateShapes(updates as never);
    });
}
