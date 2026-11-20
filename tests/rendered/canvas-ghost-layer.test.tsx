/**
 * GHOSTS ARE NEVER RECORDS (Phase 3.3, D24). With the book's pending new
 * elements and relations handed to a mounted tldraw editor as a preview:
 *
 *   - the ghosts are drawn (a node, a line), over the canvas, distinct;
 *   - the editor's store holds no record of them, so the serializer — which
 *     the save, the snapshot and the diff all go through — returns exactly the
 *     map's own rows, and the map is not marked dirty;
 *   - a ghost takes no pointer events (it cannot be selected or moved);
 *   - a preview that throws while drawing draws nothing and says so
 *     (`onPreviewFailed`), and the canvas stays.
 *
 * jsdom proves wiring, never pixels (`tests/helpers/tldraw-jsdom.ts`).
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import type { StructurePreviewValue } from '@/components/canvas/GhostLayer';
import { StoryMapCanvas } from '@/components/canvas/StoryMapCanvas';
import { serializeEditorCanvas } from '@/components/canvas/tldraw/editor-canvas';
import type { GraphRows, MapDisplay } from '@/components/canvas/tldraw/serializer';
import type { PendingStructureView } from '@/lib/enrichment/api-client';

const DISPLAY: MapDisplay = { nodes: new Map(), edgeLabels: new Map() };
const ROWS: GraphRows = {
    nodes: [
        { elementId: 'el-a', x: 0, y: 0, w: 220, h: 88, lane: null },
        { elementId: 'el-b', x: 400, y: 0, w: 220, h: 88, lane: null },
    ],
    edges: [],
};

const common = { roundNumber: 1, status: 'PENDING' as const, flags: [], citedAnswerIds: ['a1'], decidedAt: null, sessionId: 's1' };
const PENDING: PendingStructureView[] = [
    { ...common, id: 'p-new', kind: 'NEW_ELEMENT', newKind: 'CHARACTER', name: 'Ottoline Brack', summary: null, createdElementId: null, fields: [], slot: null },
    {
        ...common,
        id: 'p-rel',
        kind: 'NEW_RELATION',
        type: 'loves',
        label: 'loves',
        from: { elementId: 'el-a', proposalId: null, name: 'A', kind: 'CHARACTER', exists: true },
        to: { elementId: 'el-b', proposalId: null, name: 'B', kind: 'CHARACTER', exists: true },
        note: null,
        fields: [],
        createdRelationId: null,
    },
    {
        ...common,
        id: 'p-rel-new',
        kind: 'NEW_RELATION',
        type: 'sibling_of',
        label: 'sibling of',
        from: { elementId: 'el-a', proposalId: null, name: 'A', kind: 'CHARACTER', exists: true },
        to: { elementId: null, proposalId: 'p-new', name: 'Ottoline Brack', kind: 'CHARACTER', exists: false },
        note: null,
        fields: [],
        createdRelationId: null,
    },
];

function preview(overrides: Partial<StructurePreviewValue> = {}): StructurePreviewValue {
    return {
        pending: PENDING,
        drawnKinds: new Set(['CHARACTER', 'FACTION']),
        kindLabels: { CHARACTER: 'Character' },
        words: { proposed: 'Proposed', between: (a, b) => `${a} ${b}` },
        lanes: null,
        ...overrides,
    };
}

async function mount(value: StructurePreviewValue | null) {
    let editor: Editor | undefined;
    let dirty = 0;
    const view = await act(async () =>
        render(
            <div style={{ width: 1000, height: 700 }}>
                <StoryMapCanvas rows={ROWS} display={DISPLAY} relations={() => []} preview={value} onDirty={() => (dirty += 1)} onEditorReady={(e) => (editor = e)} />
            </div>,
        ),
    );
    if (!editor) throw new Error('the canvas did not mount');
    return { editor, container: view.container, dirty: () => dirty };
}

describe('the ghost layer', () => {
    it('draws the pending proposals as ghosts, none of them a record: the serializer returns the map’s own rows', async () => {
        const plain = await mount(null);
        const before = serializeEditorCanvas(plain.editor);

        const { editor, container, dirty } = await mount(preview());
        const nodes = container.querySelectorAll('[data-ghost-node]');
        expect([...nodes].map((n) => n.getAttribute('data-ghost-node'))).toEqual(['p-new']);
        expect(nodes[0].textContent).toContain('Ottoline Brack');
        expect(nodes[0].textContent).toContain('Proposed');
        expect([...container.querySelectorAll('[data-ghost-edge]')].map((e) => e.getAttribute('data-ghost-edge')).sort()).toEqual(['p-rel', 'p-rel-new']);

        // Nothing of them in the store, so nothing of them in a save.
        const canvas = serializeEditorCanvas(editor);
        expect(canvas).toEqual(before);
        expect(JSON.stringify(canvas)).not.toContain('p-new');
        expect(JSON.stringify(editor.store.allRecords())).not.toContain('Ottoline');
        expect(dirty()).toBe(0);
        // Not selectable: the layer takes no pointer events.
        expect(container.querySelector('[data-ghost-layer]')!.className).toContain('pointer-events-none');
    });

    it('a preview that throws draws nothing, says so, and leaves the canvas', async () => {
        const failed: string[] = [];
        const broken = preview({ pending: [{ ...PENDING[0], kind: 'NEW_ELEMENT', name: undefined as unknown as string, status: 'PENDING', get newKind(): never { throw new Error('bad preview'); } } as unknown as PendingStructureView], onPreviewFailed: () => failed.push('failed') });
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const { editor, container } = await mount(broken);
        spy.mockRestore();
        expect(failed.length).toBeGreaterThan(0);
        expect(container.querySelector('[data-ghost-node]')).toBeNull();
        expect(serializeEditorCanvas(editor).rows.nodes).toHaveLength(2);
        expect(container.querySelector('[data-story-canvas]')).not.toBeNull();
    });
});
