/**
 * The freeform layer on its way into storage (Phase 3.1): bounded, shaped,
 * free of prototype keys and sanitised, and an empty layer is NULL.
 */
import { bindingIdForRelation } from '@/components/canvas/tldraw/story-edge-binding';
import { shapeIdForRelation } from '@/components/canvas/tldraw/story-edge-shape';
import { shapeIdForElement } from '@/components/canvas/tldraw/story-node-shape';
import { assertFreeformIdsFree, parseStoredFreeform, rowRecordIds, sanitiseFreeformForStorage, sanitiseFreeformRecords } from '@/lib/canvas/freeform';
import { FREEFORM_MAX_RECORDS } from '@/lib/canvas/limits';
import { ValidationError } from '@/lib/errors/types';

const note = (id: string, text: string) => ({
    id,
    typeName: 'shape',
    type: 'note',
    x: 1,
    y: 2,
    props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
});

function problemOf(input: unknown): string | undefined {
    try {
        sanitiseFreeformForStorage(input);
        return undefined;
    } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        const details = (err as ValidationError).details as { reason: string; problem: string };
        expect(details.reason).toBe('FREEFORM_REFUSED');
        return details.problem;
    }
}

it('an empty layer is stored as NULL, and NULL reads back as empty', () => {
    expect(sanitiseFreeformForStorage([])).toBeNull();
    expect(parseStoredFreeform(null)).toEqual([]);
    expect(parseStoredFreeform('not json')).toEqual([]);
});

it('keeps an ordinary note exactly, and round-trips it through storage', () => {
    const stored = sanitiseFreeformForStorage([note('shape:a1', 'Ada meets Bea at the ball')]);
    expect(parseStoredFreeform(stored)).toEqual([note('shape:a1', 'Ada meets Bea at the ball')]);
});

it('strips markup and control characters from every string, but never trims the words beside a mark', () => {
    const [r] = sanitiseFreeformRecords([note('shape:a1', 'Hello <script>alert(1)</script><b>world</b> \u0000')]);
    const text = (r.props as { richText: { content: Array<{ content: Array<{ text: string }> }> } }).richText.content[0].content[0].text;
    expect(text).toBe('Hello world ');
    expect(text).not.toMatch(/[<>\u0000]/);
});

it('refuses prototype keys at any depth (GHSA-cp6q-959q-f8rh), however they arrived', () => {
    const smuggled = JSON.parse('[{"id":"shape:a","typeName":"shape","type":"note","props":{"richText":{"attrs":{"__proto__":{"onclick":"x"}}}}}]');
    expect(problemOf(smuggled)).toBe('FORBIDDEN_KEY');
    expect(problemOf([{ ...note('shape:a', 'x'), constructor: {} }])).toBe('FORBIDDEN_KEY');
});

it('refuses the canvas’s own record types: a node, an edge or an edge line belongs to the rows', () => {
    for (const type of ['story-node', 'story-edge-line']) expect(problemOf([{ ...note('shape:a', 'x'), type }])).toBe('STRUCTURED_TYPE');
    expect(problemOf([{ id: 'binding:a', typeName: 'binding', type: 'story-edge' }])).toBe('STRUCTURED_TYPE');
});

it('refuses what is not a tldraw shape or binding record', () => {
    expect(problemOf({})).toBe('NOT_A_LIST');
    expect(problemOf(['x'])).toBe('NOT_A_RECORD');
    expect(problemOf([{ id: 'camera:a', typeName: 'shape' }])).toBe('BAD_ID');
    expect(problemOf([{ id: 'shape:a', typeName: 'camera' }])).toBe('BAD_TYPE_NAME');
    expect(problemOf([note('shape:a', 'x'), note('shape:a', 'y')])).toBe('DUPLICATE_ID');
});

it('refuses past the bounds: records, depth and bytes', () => {
    expect(problemOf(Array.from({ length: FREEFORM_MAX_RECORDS + 1 }, (_, i) => note(`shape:n${i}`, 'x')))).toBe('TOO_MANY_RECORDS');
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(problemOf([{ ...note('shape:a', 'x'), props: deep }])).toBe('TOO_DEEP');
    expect(problemOf([note('shape:a', 'x'.repeat(600 * 1024))])).toBe('TOO_LARGE');
});

describe('a record carrying a node’s or an edge’s id', () => {
    const nodes = [{ elementId: 'el-a' }, { elementId: 'el-b' }];
    const edges = [{ relationId: 'rel-ab' }];
    const problem = (freeform: Record<string, unknown>[]) => {
        try {
            assertFreeformIdsFree(freeform, nodes, edges);
            return undefined;
        } catch (err) {
            expect(err).toBeInstanceOf(ValidationError);
            const details = (err as ValidationError).details as { reason: string; problem: string; index: number };
            expect(details.reason).toBe('FREEFORM_REFUSED');
            return `${details.problem}@${details.index}`;
        }
    };

    it('is refused RESERVED_ID: tldraw would draw it over the node, the line or the binding', () => {
        expect(problem([note('shape:x', 'a'), note('shape:el-a', 'b')])).toBe('RESERVED_ID@1');
        expect(problem([note('shape:edge-rel-ab', 'b')])).toBe('RESERVED_ID@0');
        expect(problem([{ id: 'binding:rel-ab', typeName: 'binding', type: 'arrow' }])).toBe('RESERVED_ID@0');
        // Another element's or relation's id is not this save's.
        expect(problem([note('shape:el-c', 'b'), { id: 'binding:rel-cd', typeName: 'binding', type: 'arrow' }])).toBeUndefined();
    });

    it('the reserved ids are spelled exactly as the canvas derives them', () => {
        expect(rowRecordIds(nodes, edges)).toEqual(new Set([shapeIdForElement('el-a'), shapeIdForElement('el-b'), String(shapeIdForRelation('rel-ab')), bindingIdForRelation('rel-ab')]));
    });
});
