/**
 * A malformed rich-text note in a stored map does not take the canvas down
 * (issue #45, item 3; Phase 3.H).
 *
 * The freeform layer holds tldraw's own records, read back from storage. A
 * note whose rich text names a node TipTap's schema does not hold, or an
 * empty text node, passes tldraw's record validator (it checks the shape of
 * the document, not its nodes) and throws only when the note is MEASURED —
 * in geometry, outside tldraw's per-shape error boundary — so the first
 * `zoomToFit` or render threw and the whole canvas fell to its error
 * boundary. The restore now proves each record can be measured: a note whose
 * text cannot be rendered keeps its words as plain text, and a record that
 * still cannot be measured is left out, never the map.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor, TLShapeId } from 'tldraw';
import { renderPlaintextFromRichText } from 'tldraw';

import { StoryMapCanvas } from '@/components/canvas/StoryMapCanvas';
import { serializeEditorCanvas } from '@/components/canvas/tldraw/editor-canvas';
import type { GraphRows, MapDisplay } from '@/components/canvas/tldraw/serializer';

const ROWS: GraphRows = { nodes: [{ elementId: 'el-a', x: 0, y: 0, w: 220, h: 88, lane: null }], edges: [] };
const DISPLAY: MapDisplay = { nodes: new Map(), edgeLabels: new Map() };

const note = (id: string, richText: unknown) => ({
    id,
    typeName: 'shape',
    type: 'note',
    x: 50,
    y: 300,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    index: 'a5',
    parentId: 'page:page',
    meta: {},
    props: { richText },
});

const UNKNOWN_NODE = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'spaceship', content: [{ type: 'text', text: 'keep these words' }] }] }] };
const EMPTY_TEXT = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] };
const GOOD = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a good note' }] }] };

async function mount(freeform: unknown[]): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 1000, height: 700 }}>
                <StoryMapCanvas rows={ROWS} display={DISPLAY} freeform={freeform as never} relations={() => []} onEditorReady={(e) => (editor = e)} />
            </div>,
        );
    });
    if (!editor) throw new Error('the canvas did not mount: a malformed note took it down');
    return editor;
}

it('a note naming a node the schema does not hold keeps its words as plain text, and the map loads', async () => {
    const editor = await mount([note('shape:bad', UNKNOWN_NODE), note('shape:good', GOOD)]);
    const bad = editor.getShape('shape:bad' as TLShapeId);
    expect(bad).toBeDefined();
    expect(() => editor.getShapeGeometry('shape:bad' as TLShapeId)).not.toThrow();
    expect(renderPlaintextFromRichText(editor, (bad!.props as { richText: never }).richText)).toBe('keep these words');
    expect(renderPlaintextFromRichText(editor, (editor.getShape('shape:good' as TLShapeId)!.props as { richText: never }).richText)).toBe('a good note');
    // The rows are untouched and the map still saves.
    expect(serializeEditorCanvas(editor).rows).toEqual(ROWS);
});

it('an empty text node (which TipTap refuses) does not take the map down either', async () => {
    const editor = await mount([note('shape:empty', EMPTY_TEXT)]);
    expect(() => editor.getShapeGeometry('shape:empty' as TLShapeId)).not.toThrow();
    expect(serializeEditorCanvas(editor).rows).toEqual(ROWS);
});
