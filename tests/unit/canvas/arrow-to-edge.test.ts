/**
 * What an arrow drawn on a story map becomes (Phase 3.1), and the edge rules
 * it and the save share. Pure: no editor.
 *
 * Adapted from inflect-compliance's `arrow-to-edge-classify.test.ts` and
 * `edge-validation.test.ts` (docs/carve-manifest.md): an edge here draws a
 * bible relation, so an arrow becomes an edge only when one joins its ends.
 */
import { classifyArrow, type ArrowEnd } from '@/components/canvas/tldraw/arrow-to-edge';
import { validateEdge, type KnownRelation } from '@/components/canvas/tldraw/edge-validation';

const nodes = new Set(['a', 'b', 'c']);
const R1: KnownRelation = { relationId: 'r1', sourceElementId: 'a', targetElementId: 'b' };
const R2: KnownRelation = { relationId: 'r2', sourceElementId: 'b', targetElementId: 'a' };
const ends = (start: string | null, end: string | null): ArrowEnd[] => [
    { terminal: 'start', elementId: start },
    { terminal: 'end', elementId: end },
];

describe('classifyArrow', () => {
    it('an arrow between two related nodes becomes that relation’s edge', () => {
        expect(classifyArrow(ends('a', 'b'), nodes, new Set(), [R1])).toEqual({ kind: 'convert', relationId: 'r1', sourceElementId: 'a', targetElementId: 'b' });
    });

    it('the edge runs the RELATION’s way, whichever way the arrow was drawn', () => {
        expect(classifyArrow(ends('b', 'a'), nodes, new Set(), [R1])).toEqual({ kind: 'convert', relationId: 'r1', sourceElementId: 'a', targetElementId: 'b' });
    });

    it('with several relations between the pair, the first not yet drawn; with all drawn, DUPLICATE_EDGE', () => {
        expect(classifyArrow(ends('a', 'b'), nodes, new Set(['r1']), [R1, R2])).toMatchObject({ kind: 'convert', relationId: 'r2' });
        expect(classifyArrow(ends('a', 'b'), nodes, new Set(['r1', 'r2']), [R1, R2])).toEqual({ kind: 'refuse', refusals: [{ code: 'DUPLICATE_EDGE', relationId: 'r1' }] });
    });

    it('two unrelated nodes: no-relation (3.2 adds the picker that creates one), never a made-up edge', () => {
        expect(classifyArrow(ends('a', 'c'), nodes, new Set(), [R1])).toEqual({ kind: 'no-relation', sourceElementId: 'a', targetElementId: 'c' });
    });

    it('an arrow with a free end, or bound to something that is not a node, is an annotation', () => {
        expect(classifyArrow([{ terminal: 'start', elementId: 'a' }], nodes, new Set(), [R1])).toEqual({ kind: 'annotation', why: 'FEWER_THAN_TWO_ENDS' });
        expect(classifyArrow(ends('a', null), nodes, new Set(), [R1])).toEqual({ kind: 'annotation', why: 'END_IS_NOT_A_NODE' });
    });

    it('an arrow from a node to itself is refused SELF_LOOP', () => {
        expect(classifyArrow(ends('a', 'a'), nodes, new Set(), [R1])).toEqual({ kind: 'refuse', refusals: [{ code: 'SELF_LOOP', elementId: 'a' }] });
    });
});

describe('validateEdge', () => {
    it('accepts the relation’s own pair, both on the map, not yet drawn', () => {
        expect(validateEdge(R1, nodes, new Set(), R1)).toEqual([]);
    });

    it('returns EVERY refusal, not the first', () => {
        expect(validateEdge({ relationId: 'r1', sourceElementId: 'x', targetElementId: 'y' }, nodes, new Set(['r1']), R1).map((r) => r.code)).toEqual([
            'UNKNOWN_NODE',
            'UNKNOWN_NODE',
            'DUPLICATE_EDGE',
            'RELATION_MISMATCH',
        ]);
    });

    it('an edge whose ends are reversed from its relation, or with no relation, is a mismatch', () => {
        expect(validateEdge({ relationId: 'r1', sourceElementId: 'b', targetElementId: 'a' }, nodes, new Set(), R1).map((r) => r.code)).toEqual(['RELATION_MISMATCH']);
        expect(validateEdge(R1, nodes, new Set(), undefined).map((r) => r.code)).toEqual(['RELATION_MISMATCH']);
    });
});
