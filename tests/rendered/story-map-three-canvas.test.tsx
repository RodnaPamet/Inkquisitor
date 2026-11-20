/**
 * The three maps under a mounted tldraw editor (Phase 3.2): an arrow between
 * two unrelated nodes asks the host for a relation (the type picker) and is
 * kept for it; deleting an edge whose nodes stay is reported (the relation is
 * removed from the bible, with undo), an edge going with its node is not; on a
 * derived map a dropped card is reported, putting cards where the bible says
 * is no edit, and a lane card keeps the lane's size; a double-click opens the
 * element.
 *
 * jsdom proves wiring, never pixels (`tests/helpers/tldraw-jsdom.ts`).
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor, TLShapeId } from 'tldraw';

import { StoryMapCanvas } from '@/components/canvas/StoryMapCanvas';
import type { RelationRequest } from '@/components/canvas/tldraw/arrow-to-edge';
import { placeCards } from '@/components/canvas/tldraw/lane-host';
import type { GraphRows, MapDisplay } from '@/components/canvas/tldraw/serializer';
import { shapeIdForRelation } from '@/components/canvas/tldraw/story-edge-shape';
import { shapeIdForElement } from '@/components/canvas/tldraw/story-node-shape';
import { StoryNodeShapeUtil } from '@/components/canvas/tldraw/StoryNodeShapeUtil';
import { deriveLaneLayout, type NodePlacement } from '@/lib/canvas/lanes';

const DISPLAY: MapDisplay = { nodes: new Map(), edgeLabels: new Map([['rel-ab', 'loves']]) };
const FREE: GraphRows = {
    nodes: [
        { elementId: 'el-a', x: 0, y: 0, w: 220, h: 88, lane: null },
        { elementId: 'el-b', x: 400, y: 0, w: 220, h: 88, lane: null },
        { elementId: 'el-c', x: 800, y: 0, w: 220, h: 88, lane: null },
    ],
    edges: [{ relationId: 'rel-ab', sourceElementId: 'el-a', targetElementId: 'el-b' }],
};
const RELATIONS = [{ relationId: 'rel-ab', sourceElementId: 'el-a', targetElementId: 'el-b' }];

interface Seen {
    dirty: number;
    needs: RelationRequest[];
    removed: string[];
    drops: Array<{ elementId: string; center: { x: number; y: number } }>;
    opened: string[];
}

async function mount(rows: GraphRows, layout: 'free' | 'derived' = 'free'): Promise<{ editor: Editor; seen: Seen }> {
    const seen: Seen = { dirty: 0, needs: [], removed: [], drops: [], opened: [] };
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 1000, height: 700 }}>
                <StoryMapCanvas
                    rows={rows}
                    display={DISPLAY}
                    relations={() => RELATIONS}
                    layout={layout}
                    onDirty={() => (seen.dirty += 1)}
                    onNeedsRelation={(r) => seen.needs.push(r)}
                    onEdgeRemoved={(e) => seen.removed.push(e.relationId)}
                    onCardsDropped={(d) => seen.drops.push(...d)}
                    onNodeOpen={(id) => seen.opened.push(id)}
                    onEditorReady={(e) => (editor = e)}
                />
            </div>,
        );
    });
    if (!editor) throw new Error('the canvas did not mount');
    return { editor, seen };
}

async function drawArrow(editor: Editor, start: string, end: string): Promise<TLShapeId> {
    const arrowId = `shape:arrow-${start}-${end}` as TLShapeId;
    await act(async () => {
        editor.createShapes([{ id: arrowId, type: 'arrow', x: 0, y: 0, props: {} }]);
        editor.createBindings([
            { type: 'arrow', fromId: arrowId, toId: shapeIdForElement(start) as TLShapeId, props: { terminal: 'start', isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 } } },
            { type: 'arrow', fromId: arrowId, toId: shapeIdForElement(end) as TLShapeId, props: { terminal: 'end', isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 } } },
        ] as never);
    });
    return arrowId;
}

describe('relations drawn and removed', () => {
    it('an arrow between two unrelated nodes asks the host for a relation, from the arrow’s start, and is left for it', async () => {
        const { editor, seen } = await mount(FREE);
        const arrowId = await drawArrow(editor, 'el-c', 'el-a');
        expect(seen.needs).toEqual([{ arrowId, fromElementId: 'el-c', toElementId: 'el-a' }]);
        expect(editor.getShape(arrowId)).toBeDefined();
    });

    it('so does an arrow along a relation already drawn: the author may want another', async () => {
        const { editor, seen } = await mount(FREE);
        await drawArrow(editor, 'el-b', 'el-a');
        expect(seen.needs.map((n) => [n.fromElementId, n.toElementId])).toEqual([['el-b', 'el-a']]);
    });

    it('deleting an edge whose two nodes stay is reported (its relation goes from the bible); an edge going with its node is not', async () => {
        const { editor, seen } = await mount(FREE);
        await act(async () => {
            editor.deleteShapes([shapeIdForRelation('rel-ab')]);
        });
        expect(seen.removed).toEqual(['rel-ab']);

        const again = await mount(FREE);
        await act(async () => {
            again.editor.deleteShapes([shapeIdForElement('el-a') as TLShapeId]);
        });
        expect(again.seen.removed).toEqual([]);
    });

    it('a double-click on a node opens its element', async () => {
        const { editor, seen } = await mount(FREE);
        const shape = editor.getShape(shapeIdForElement('el-b') as TLShapeId)!;
        await act(async () => {
            editor.emit('event', { type: 'click', name: 'double_click', target: 'shape', shape, phase: 'up' } as never);
        });
        expect(seen.opened).toEqual(['el-b']);
    });
});

describe('a derived map (the plot board, the timeline)', () => {
    const layout = deriveLaneLayout('TIMELINE', [
        { elementId: 'e1', name: 'One', orderRank: 'b', act: null },
        { elementId: 'e2', name: 'Two', orderRank: 'm', act: null },
    ])!;
    const rows: GraphRows = {
        nodes: [...layout.positions].map(([elementId, p]) => ({ elementId, ...p })),
        edges: [],
    };

    it('a card dragged and let go is reported at its centre, and is not a map edit', async () => {
        const { editor, seen } = await mount(rows, 'derived');
        const id = shapeIdForElement('e1') as TLShapeId;
        await act(async () => {
            editor.updateShapes([{ id, type: 'story-node', x: 900, y: 40 }]);
        });
        expect(seen.drops).toEqual([{ elementId: 'e1', center: { x: 900 + 100, y: 40 + 44 } }]);
        expect(seen.dirty).toBe(0);
    });

    it('putting cards where the bible says is neither an edit nor a drop', async () => {
        const { editor, seen } = await mount(rows, 'derived');
        const swapped = new Map<string, NodePlacement>([
            ['e1', layout.positions.get('e2')!],
            ['e2', layout.positions.get('e1')!],
        ]);
        await act(async () => {
            placeCards(editor, swapped);
        });
        expect(editor.getShape(shapeIdForElement('e1') as TLShapeId)!.x).toBe(layout.positions.get('e2')!.x);
        expect(seen).toMatchObject({ dirty: 0, drops: [] });
    });

    it('a lane card keeps the lane’s size; a relationship map node may be resized', async () => {
        const { editor } = await mount(rows, 'derived');
        const util = editor.getShapeUtil('story-node') as StoryNodeShapeUtil;
        expect(util.canResize(editor.getShape(shapeIdForElement('e1') as TLShapeId) as never)).toBe(false);
        const free = await mount(FREE);
        expect(util.canResize(free.editor.getShape(shapeIdForElement('el-a') as TLShapeId) as never)).toBe(true);
    });
});
