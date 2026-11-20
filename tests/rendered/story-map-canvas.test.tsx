/**
 * The story canvas under a mounted tldraw editor (Phase 3.1): seeding from
 * rows, the round trip through a LIVE store, arrows becoming edges only along
 * a bible relation, one node per element, the reader's view, and what the
 * dirty signal fires for.
 *
 * jsdom proves wiring, never pixels (`tests/helpers/tldraw-jsdom.ts`); the
 * E2E spec drives the real browser.
 */
import { installTldrawJsdomShims, tldrawFetches } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor, TLShapeId } from 'tldraw';

import { StoryMapCanvas } from '@/components/canvas/StoryMapCanvas';
import { addElementNode } from '@/components/canvas/tldraw/add-element-node';
import { runAutoLayout } from '@/components/canvas/tldraw/auto-layout-host';
import type { ArrowVerdict } from '@/components/canvas/tldraw/arrow-to-edge';
import type { KnownRelation } from '@/components/canvas/tldraw/edge-validation';
import { serializeEditorCanvas } from '@/components/canvas/tldraw/editor-canvas';
import type { GraphRows, MapDisplay } from '@/components/canvas/tldraw/serializer';
import { STORY_EDGE_BINDING_TYPE } from '@/components/canvas/tldraw/story-edge-binding';
import { STORY_EDGE_SHAPE_TYPE } from '@/components/canvas/tldraw/story-edge-shape';
import { STORY_NODE_SHAPE_TYPE, shapeIdForElement } from '@/components/canvas/tldraw/story-node-shape';
import { CANVAS_ASSET_BASE } from '@/lib/canvas/tldraw-assets';

const ROWS: GraphRows = {
    nodes: [
        { elementId: 'el-a', x: 0, y: 0, w: 220, h: 88, lane: null },
        { elementId: 'el-b', x: 400, y: 0, w: 260, h: 100, lane: 'act-1' },
        { elementId: 'el-c', x: 800, y: 0, w: 220, h: 88, lane: null },
    ],
    edges: [{ relationId: 'rel-ab', sourceElementId: 'el-a', targetElementId: 'el-b' }],
};
const RELATIONS: KnownRelation[] = [
    { relationId: 'rel-ab', sourceElementId: 'el-a', targetElementId: 'el-b' },
    { relationId: 'rel-cb', sourceElementId: 'el-c', targetElementId: 'el-b' },
];
const DISPLAY: MapDisplay = {
    nodes: new Map([['el-a', { name: 'Ada', kindLabel: 'Character', badgeLabel: '40%', badgeTone: 'partial' }]]),
    edgeLabels: new Map([
        ['rel-ab', 'mentors'],
        ['rel-cb', 'rivals'],
    ]),
};
const NOTE = { id: 'shape:note1', typeName: 'shape', type: 'note', x: 50, y: 300, rotation: 0, isLocked: false, opacity: 1, index: 'a5', parentId: 'page:page', meta: {}, props: {} };

let dirty = 0;
const refused: Array<Extract<ArrowVerdict, { kind: 'refuse' | 'no-relation' }>> = [];

async function mount(opts: { rows?: GraphRows; readOnly?: boolean; freeform?: unknown[] } = {}): Promise<Editor> {
    dirty = 0;
    refused.length = 0;
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 1000, height: 700 }}>
                <StoryMapCanvas
                    rows={opts.rows ?? ROWS}
                    display={DISPLAY}
                    freeform={(opts.freeform ?? []) as never}
                    readOnly={opts.readOnly}
                    relations={() => RELATIONS}
                    onDirty={() => (dirty += 1)}
                    onEdgeRefused={(v) => refused.push(v)}
                    onEditorReady={(e) => (editor = e)}
                />
            </div>,
        );
    });
    if (!editor) throw new Error('the canvas did not mount');
    return editor;
}

async function drawArrow(editor: Editor, start: string, end: string): Promise<void> {
    const arrowId = `shape:arrow-${start}-${end}-${Math.random().toString(36).slice(2, 7)}` as TLShapeId;
    await act(async () => {
        editor.createShapes([{ id: arrowId, type: 'arrow', x: 0, y: 0, props: {} }]);
        editor.createBindings([
            { type: 'arrow', fromId: arrowId, toId: shapeIdForElement(start) as TLShapeId, props: { terminal: 'start', isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 } } },
            { type: 'arrow', fromId: arrowId, toId: shapeIdForElement(end) as TLShapeId, props: { terminal: 'end', isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 } } },
        ] as never);
    });
}

const ofType = (editor: Editor, typeName: string, type: string) => editor.store.allRecords().filter((r) => r.typeName === typeName && (r as { type?: string }).type === type);

describe('seeding', () => {
    it('loads every node, edge and edge line from the rows, and the freeform layer beside them', async () => {
        const editor = await mount({ freeform: [NOTE] });
        expect(ofType(editor, 'shape', STORY_NODE_SHAPE_TYPE)).toHaveLength(3);
        expect(ofType(editor, 'binding', STORY_EDGE_BINDING_TYPE)).toHaveLength(1);
        expect(ofType(editor, 'shape', STORY_EDGE_SHAPE_TYPE)).toHaveLength(1);
        expect(editor.getShape('shape:note1' as TLShapeId)).toBeDefined();
    });

    it('is not an edit: opening a map marks nothing dirty', async () => {
        await mount({ freeform: [NOTE] });
        expect(dirty).toBe(0);
    });

    it('round-trips through the LIVE store: what is saved is exactly what was loaded', async () => {
        const editor = await mount({ freeform: [NOTE] });
        const canvas = serializeEditorCanvas(editor);
        expect(canvas.rows).toEqual(ROWS);
        // The derived edge line is not in the freeform layer; the note is, once.
        expect(canvas.freeform.map((r) => r.id)).toEqual(['shape:note1']);
    });

    it('asks tldraw’s CDN for nothing: its assets are ours', async () => {
        tldrawFetches.length = 0;
        await mount();
        for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
        expect(tldrawFetches.length).toBeGreaterThan(0);
        for (const url of tldrawFetches) expect(url.startsWith(CANVAS_ASSET_BASE)).toBe(true);
    });
});

describe('edits', () => {
    it('a moved node is an edit, saved at its new place', async () => {
        const editor = await mount();
        await act(async () => {
            editor.updateShape({ id: shapeIdForElement('el-a') as TLShapeId, type: STORY_NODE_SHAPE_TYPE, x: 33, y: 44 });
        });
        expect(dirty).toBeGreaterThan(0);
        expect(serializeEditorCanvas(editor).rows.nodes.find((n) => n.elementId === 'el-a')).toMatchObject({ x: 33, y: 44 });
    });

    it('a node added from the book lands once; adding it again selects it rather than drawing a second', async () => {
        const editor = await mount();
        let first = { added: false };
        await act(async () => {
            first = addElementNode(editor, 'el-new', { name: 'New', kindLabel: 'Setting', badgeLabel: '0%', badgeTone: 'none' });
        });
        await act(async () => {
            addElementNode(editor, 'el-new', { name: 'New', kindLabel: 'Setting', badgeLabel: '0%', badgeTone: 'none' });
        });
        expect(first.added).toBe(true);
        expect(serializeEditorCanvas(editor).rows.nodes.filter((n) => n.elementId === 'el-new')).toHaveLength(1);
        expect(dirty).toBeGreaterThan(0);
    });

    it('a duplicated node is removed: an element is on a map once', async () => {
        const editor = await mount();
        await act(async () => {
            editor.duplicateShapes([shapeIdForElement('el-c') as TLShapeId]);
        });
        expect(serializeEditorCanvas(editor).rows.nodes.filter((n) => n.elementId === 'el-c')).toHaveLength(1);
    });

    it('arrange moves the nodes in one step, which undo takes back', async () => {
        const editor = await mount();
        const before = serializeEditorCanvas(editor).rows.nodes;
        await act(async () => {
            editor.markHistoryStoppingPoint('arrange');
            expect(runAutoLayout(editor, 'TB')).toBe(3);
        });
        expect(serializeEditorCanvas(editor).rows.nodes).not.toEqual(before);
        await act(async () => {
            editor.undo();
        });
        expect(serializeEditorCanvas(editor).rows.nodes).toEqual(before);
    });
});

describe('an arrow between two nodes', () => {
    it('becomes the relation’s edge, its own way round, with its line and label, and the arrow goes', async () => {
        const editor = await mount();
        await drawArrow(editor, 'el-b', 'el-c');
        const edges = serializeEditorCanvas(editor).rows.edges;
        expect(edges).toContainEqual({ relationId: 'rel-cb', sourceElementId: 'el-c', targetElementId: 'el-b' });
        expect(ofType(editor, 'shape', 'arrow')).toHaveLength(0);
        const line = ofType(editor, 'shape', STORY_EDGE_SHAPE_TYPE).find((s) => (s as unknown as { props: { relationId: string } }).props.relationId === 'rel-cb');
        expect((line as unknown as { props: { label: string } }).props.label).toBe('rivals');
        expect(dirty).toBeGreaterThan(0);
    });

    it('between two unrelated elements stays an arrow, and says why', async () => {
        const editor = await mount();
        await drawArrow(editor, 'el-a', 'el-c');
        expect(serializeEditorCanvas(editor).rows.edges).toHaveLength(1);
        expect(refused).toEqual([{ kind: 'no-relation', sourceElementId: 'el-a', targetElementId: 'el-c' }]);
    });

    it('along a relation already drawn is refused DUPLICATE_EDGE', async () => {
        const editor = await mount();
        await drawArrow(editor, 'el-a', 'el-b');
        expect(serializeEditorCanvas(editor).rows.edges).toHaveLength(1);
        expect(refused[0]).toEqual({ kind: 'refuse', refusals: [{ code: 'DUPLICATE_EDGE', relationId: 'rel-ab' }] });
    });

    it('a converted edge is undone in one step', async () => {
        const editor = await mount();
        await drawArrow(editor, 'el-c', 'el-b');
        expect(serializeEditorCanvas(editor).rows.edges).toHaveLength(2);
        await act(async () => {
            editor.undo();
        });
        expect(serializeEditorCanvas(editor).rows.edges.map((e) => e.relationId)).toEqual(['rel-ab']);
    });
});

describe('a reader', () => {
    it('cannot write: tldraw refuses a new node, and no arrow converter is installed', async () => {
        const editor = await mount({ readOnly: true });
        await act(async () => {
            addElementNode(editor, 'el-new', { name: 'New', kindLabel: 'Setting', badgeLabel: '', badgeTone: 'none' });
        });
        expect(serializeEditorCanvas(editor).rows).toEqual(ROWS);
        expect(dirty).toBe(0);
    });
});
