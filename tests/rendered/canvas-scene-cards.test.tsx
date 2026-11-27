/**
 * SCENE CARDS ARE NEVER RECORDS (Phase 5.1, D33 addendum item B, owner decision
 * 2026-11-27). With the plot board's beat-to-scene links handed to a mounted
 * tldraw editor:
 *
 *   - each beat's linked scenes are drawn as cards on the board, at most
 *     `BOARD_SCENES_PER_BEAT` a beat, a "+N more" card for the rest, inside the
 *     beat's width (the derived layout is left exactly as it is);
 *   - the editor's store holds no record of them, so the serializer — which a
 *     save, a snapshot and the diff all go through — returns exactly the map's
 *     own rows (`tldrawToRows(rowsToTldraw(rows))` stays the identity), and the
 *     map is not marked dirty;
 *   - a card is a link to the scene's editor: a click opens it (and is not a
 *     selection), the card takes focus (the E2E presses Enter on it), "+N more" opens the beat;
 *   - cards that throw while drawing draw nothing, and the canvas stays.
 *
 * jsdom proves wiring, never pixels (`tests/helpers/tldraw-jsdom.ts`).
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, fireEvent, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import type { SceneCardsValue } from '@/components/canvas/SceneCardLayer';
import { sceneCardBoxes, SCENE_CARD_H } from '@/components/canvas/SceneCardLayer';
import { StoryMapCanvas } from '@/components/canvas/StoryMapCanvas';
import { serializeEditorCanvas } from '@/components/canvas/tldraw/editor-canvas';
import { rowsToTldraw, tldrawToRows, type GraphRows, type MapDisplay } from '@/components/canvas/tldraw/serializer';
import type { BoardBeatScenes } from '@/lib/canvas/api-client';
import { BOARD_SCENES_PER_BEAT } from '@/lib/canvas/limits';
import { LANE_CARD_H, LANE_CARD_W, LANE_GAP, deriveLaneLayout } from '@/lib/canvas/lanes';

const DISPLAY: MapDisplay = { nodes: new Map(), edgeLabels: new Map() };
// Three beats in two acts, laid out as the plot board lays them out.
const LAYOUT = deriveLaneLayout(
    'PLOT',
    [
        { elementId: 'beat-a', name: 'The flood', orderRank: 'a', act: 'opening' },
        { elementId: 'beat-b', name: 'The bargain', orderRank: 'b', act: 'opening' },
        { elementId: 'beat-c', name: 'The reckoning', orderRank: 'c', act: 'climax' },
    ],
    { acts: [{ value: 'opening', label: 'Opening' }, { value: 'climax', label: 'Climax' }] },
)!;
const ROWS: GraphRows = {
    nodes: [...LAYOUT.positions].map(([elementId, p]) => ({ elementId, x: p.x, y: p.y, w: p.w, h: p.h, lane: p.lane })),
    edges: [],
};
const BEATS: BoardBeatScenes[] = [
    {
        beatElementId: 'beat-a',
        total: 5,
        scenes: [
            { sceneId: 'scene-1', title: 'Wren comes ashore', chapterTitle: 'One' },
            { sceneId: 'scene-2', title: null, chapterTitle: 'One' },
        ],
    },
    { beatElementId: 'beat-c', total: 1, scenes: [{ sceneId: 'scene-9', title: 'The last tide', chapterTitle: 'Nine' }] },
];

function cards(overrides: Partial<SceneCardsValue> = {}): SceneCardsValue & { opened: string[]; beats: SceneCardsValue['beats'] } {
    const opened: string[] = [];
    return {
        beats: new Map(BEATS.map((b) => [b.beatElementId, b])),
        href: (id) => `/w/ada/books/b1/manuscript/scenes/${id}`,
        onOpenScene: (id) => opened.push(`scene:${id}`),
        onOpenBeat: (id) => opened.push(`beat:${id}`),
        words: { untitled: 'Untitled scene', open: (title) => `Open scene: ${title}`, more: (n) => `+${n}`, moreAria: (n) => `${n} more scenes` },
        opened,
        ...overrides,
    };
}

async function mount(value: SceneCardsValue | null) {
    let editor: Editor | undefined;
    let dirty = 0;
    const view = await act(async () =>
        render(
            <div style={{ width: 1000, height: 700 }}>
                <StoryMapCanvas rows={ROWS} display={DISPLAY} relations={() => []} layout="derived" lanes={LAYOUT} sceneCards={value} onDirty={() => (dirty += 1)} onEditorReady={(e) => (editor = e)} />
            </div>,
        ),
    );
    if (!editor) throw new Error('the canvas did not mount');
    return { editor, container: view.container, dirty: () => dirty };
}

describe('the plot board scene cards', () => {
    it('draws each beat’s scenes as cards, none of them a record: the serializer returns the map’s own rows', async () => {
        const plain = await mount(null);
        const before = serializeEditorCanvas(plain.editor);
        expect(plain.container.querySelector('[data-scene-card]')).toBeNull();

        const value = cards();
        const { editor, container, dirty } = await mount(value);
        const drawn = [...container.querySelectorAll('[data-scene-card]')];
        expect(drawn.map((c) => [c.getAttribute('data-scene-card'), c.getAttribute('data-scene-card-beat'), c.textContent])).toEqual([
            ['scene-1', 'beat-a', 'Wren comes ashore'],
            ['scene-2', 'beat-a', 'Untitled scene'],
            ['scene-9', 'beat-c', 'The last tide'],
        ]);
        expect(drawn[0].getAttribute('href')).toBe('/w/ada/books/b1/manuscript/scenes/scene-1');
        expect(drawn[0].getAttribute('aria-label')).toBe('Open scene: Wren comes ashore');
        const more = container.querySelector('[data-scene-card-more="beat-a"]')!;
        expect(more.textContent).toBe('+3');
        expect(container.querySelector('[data-scene-card-more="beat-c"]')).toBeNull();

        // Nothing of them in the store, so nothing of them in a save, and the derived layout is untouched.
        const canvas = serializeEditorCanvas(editor);
        expect(canvas).toEqual(before);
        expect(canvas.rows).toEqual(ROWS);
        const store = JSON.stringify(editor.store.allRecords());
        for (const id of ['scene-1', 'scene-2', 'scene-9']) expect(store).not.toContain(id);
        expect(store).not.toContain('Wren comes ashore');
        expect(editor.getCurrentPageShapes()).toHaveLength(ROWS.nodes.length);
        expect(dirty()).toBe(0);
        // The rows round trip is the identity whatever cards are shown (cards are not rows).
        expect(tldrawToRows(rowsToTldraw(ROWS, DISPLAY))).toEqual(ROWS);

        // A click opens the scene (and is no selection); the card takes focus (Enter on it is the browser's: the E2E presses it); "+N more" opens the beat.
        fireEvent.click(drawn[0]);
        (drawn[2] as HTMLElement).focus();
        expect(document.activeElement).toBe(drawn[2]);
        fireEvent.click(more);
        expect(value.opened).toEqual(['scene:scene-1', 'beat:beat-a']);
        expect(editor.getSelectedShapeIds()).toEqual([]);
        expect(serializeEditorCanvas(editor)).toEqual(before);
        expect(dirty()).toBe(0);
    });

    it('keeps every card inside its beat’s width, across its bottom edge, never over another beat', () => {
        const box = { x: LANE_GAP, y: 100, w: LANE_CARD_W, h: LANE_CARD_H };
        const boxes = sceneCardBoxes(box, BEATS[0]);
        expect(boxes.map((b) => b.kind)).toEqual([...Array(BOARD_SCENES_PER_BEAT).fill('scene'), 'more']);
        for (const b of boxes) {
            expect(b.x).toBeGreaterThanOrEqual(box.x);
            expect(b.x + b.w).toBeLessThanOrEqual(box.x + box.w);
            expect(b.y).toBe(box.y + box.h - SCENE_CARD_H / 2);
            // The lower half sits in the lane's gap, short of the next beat in the lane.
            expect(b.y + SCENE_CARD_H).toBeLessThan(box.y + box.h + LANE_GAP);
        }
        expect(sceneCardBoxes(box, { beatElementId: 'x', total: 0, scenes: [] })).toEqual([]);
        // More scenes than cards, none of them readable (a cut read): the count alone, as "+N".
        expect(sceneCardBoxes(box, { beatElementId: 'x', total: 4, scenes: [] }).map((b) => b.kind)).toEqual(['more']);
    });

    it('cards that throw draw nothing, and the canvas stays', async () => {
        const broken = cards({ words: { untitled: 'U', open: () => { throw new Error('bad words'); }, more: (n) => `+${n}`, moreAria: (n) => `${n}` } });
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const { editor, container } = await mount(broken);
        spy.mockRestore();
        expect(container.querySelector('[data-scene-card]')).toBeNull();
        expect(serializeEditorCanvas(editor).rows).toEqual(ROWS);
        expect(container.querySelector('[data-story-canvas]')).not.toBeNull();
    });
});
