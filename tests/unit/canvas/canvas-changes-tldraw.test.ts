/**
 * Which tldraw store changes are edits worth saving (Phase 3.1); adapted
 * from inflect-compliance's `canvas-changes-tldraw.test.ts`
 * (docs/carve-manifest.md).
 */
import { batchIsSubstantive } from '@/lib/canvas/canvas-changes';
import { classifyTldrawDiff, type TldrawRecordLike } from '@/lib/canvas/canvas-changes-tldraw';

const node = (over: Partial<TldrawRecordLike> & { props?: Record<string, unknown> } = {}): TldrawRecordLike => ({
    typeName: 'shape',
    type: 'story-node',
    x: 0,
    y: 0,
    ...over,
    props: { elementId: 'a', w: 220, h: 88, lane: null, name: 'Ada', kindLabel: 'Character', badgeLabel: '40%', badgeTone: 'partial', ...over.props },
});
const updated = (from: TldrawRecordLike, to: TldrawRecordLike) => classifyTldrawDiff({ added: {}, removed: {}, updated: { x: [from, to] } });

it('a move, a resize and a lane change are edits', () => {
    expect(batchIsSubstantive(updated(node(), node({ x: 5 })))).toBe(true);
    expect(batchIsSubstantive(updated(node(), node({ props: { w: 300 } })))).toBe(true);
    expect(batchIsSubstantive(updated(node(), node({ props: { lane: 'act-1' } })))).toBe(true);
});

it('a change to what a node SHOWS (name, kind, badge) is not: those are the bible’s, re-derived on load', () => {
    expect(batchIsSubstantive(updated(node(), node({ props: { name: 'Ada Lovelace', badgeLabel: '60%', badgeTone: 'complete', kindLabel: 'X' } })))).toBe(false);
});

it('an edge re-attached or retargeted is an edit; its derived line moving is not', () => {
    const edge = (fromId: string): TldrawRecordLike => ({ typeName: 'binding', type: 'story-edge', fromId, toId: 'shape:b', props: { relationId: 'r', sourceElementId: 'a', targetElementId: 'b' } });
    expect(batchIsSubstantive(updated(edge('shape:a'), edge('shape:c')))).toBe(true);
    const line = (x: number): TldrawRecordLike => ({ typeName: 'shape', type: 'story-edge-line', x, y: 0, props: { relationId: 'r', label: '', dx: 1, dy: 1 } });
    expect(batchIsSubstantive(updated(line(0), line(50)))).toBe(false);
});

it('freeform is stored whole, so a sticky note rotated or edited is an edit, and a new one too', () => {
    const note = (rotation: number, text = 'hi'): TldrawRecordLike => ({ typeName: 'shape', type: 'note', x: 0, y: 0, rotation, props: { text } } as TldrawRecordLike);
    expect(batchIsSubstantive(updated(note(0), note(0.5)))).toBe(true);
    expect(batchIsSubstantive(updated(note(0), note(0, 'hello')))).toBe(true);
    expect(batchIsSubstantive(classifyTldrawDiff({ added: { n: note(0) }, removed: {}, updated: {} }))).toBe(true);
});

it('camera, pointer and other records are never edits', () => {
    expect(batchIsSubstantive(classifyTldrawDiff({ added: { c: { typeName: 'camera' } }, removed: {}, updated: { p: [{ typeName: 'pointer', x: 1 }, { typeName: 'pointer', x: 2 }] } }))).toBe(false);
});

describe('a derived map (Phase 3.2: the plot board, the timeline)', () => {
    const derived = (from: TldrawRecordLike, to: TldrawRecordLike) => classifyTldrawDiff({ added: {}, removed: {}, updated: { x: [from, to] } }, { derivedPositions: true });

    it('a node moved, resized or put in another lane is NOT an edit: its place is the bible’s, and a drag there is an order move', () => {
        expect(batchIsSubstantive(derived(node(), node({ x: 5, y: 9 })))).toBe(false);
        expect(batchIsSubstantive(derived(node(), node({ props: { w: 300, h: 10 } })))).toBe(false);
        expect(batchIsSubstantive(derived(node(), node({ props: { lane: 'crisis' } })))).toBe(false);
    });

    it('a node added, removed or pointed at another element still is, and so is freeform', () => {
        expect(batchIsSubstantive(derived(node(), node({ props: { elementId: 'b' } })))).toBe(true);
        expect(batchIsSubstantive(classifyTldrawDiff({ added: { n: node() }, removed: {}, updated: {} }, { derivedPositions: true }))).toBe(true);
        expect(batchIsSubstantive(classifyTldrawDiff({ added: {}, removed: { n: node() }, updated: {} }, { derivedPositions: true }))).toBe(true);
        const note = (x: number): TldrawRecordLike => ({ typeName: 'shape', type: 'note', x, y: 0, props: { text: 'hi' } });
        expect(batchIsSubstantive(derived(note(0), note(9)))).toBe(true);
    });
});
