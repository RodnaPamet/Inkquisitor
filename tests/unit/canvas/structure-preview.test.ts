/**
 * What a story map previews and offers of Phase 3.3 (D24), as pure functions:
 *
 *   structurePreview  a pending new element of a drawn kind is a ghost (a
 *                     slot's beside its two neighbours, any other in a column
 *                     to the right); a pending new relation is a ghost line
 *                     only when both ends are shown (a card or a ghost);
 *                     everything else is counted as undrawn, never hidden
 *   betweenSlots      each two consecutive PLACED beats of one act lane, and
 *                     nothing on another map
 *   the setup seam    a canvas target survives the new-interview query, and a
 *                     query naming nothing (or too much) is no target
 */
import { deriveLaneLayout } from '@/lib/canvas/lanes';
import { betweenSlots, GHOST_SIDE_OFFSET, structurePreview } from '@/lib/canvas/structure-preview';
import type { NewElementProposalView, NewRelationProposalView, PendingStructureView } from '@/lib/enrichment/api-client';
import { CODE_SETUP_DEFAULTS, interviewSetupQuery, SELECTION_QUERY_MAX, setupFromQuery, startRequestBody } from '@/lib/interview/setup';

const common = { roundNumber: 1, status: 'PENDING' as const, flags: [], citedAnswerIds: ['a1'], decidedAt: null, sessionId: 's1' };

function newElement(id: string, kind: string, slot: NewElementProposalView['slot'] = null): PendingStructureView {
    return { ...common, id, kind: 'NEW_ELEMENT', newKind: kind as NewElementProposalView['newKind'], name: `Beat ${id}`, summary: null, createdElementId: null, fields: [], slot };
}

function newRelation(id: string, from: { elementId?: string; proposalId?: string }, to: { elementId?: string; proposalId?: string }): PendingStructureView {
    const end = (e: { elementId?: string; proposalId?: string }): NewRelationProposalView['from'] => ({ elementId: e.elementId ?? null, proposalId: e.proposalId ?? null, name: 'x', kind: null, exists: e.elementId !== undefined });
    return { ...common, id, kind: 'NEW_RELATION', type: 'causes', label: 'causes', from: end(from), to: end(to), note: null, fields: [], createdRelationId: null };
}

const box = (x: number, y: number) => ({ x, y, w: 200, h: 88 });
const PLOT = new Set(['PLOT_BEAT']);

describe('structurePreview', () => {
    const boxes = new Map([
        ['b1', box(16, 64)],
        ['b2', box(16, 168)],
    ]);

    it('a slot’s new beat stands beside its two neighbours, between them', () => {
        const slot = { afterElementId: 'b1', afterName: 'One', beforeElementId: 'b2', beforeName: 'Two', act: 'opening', changed: null, choices: [], choicesTruncated: false };
        const { nodes, undrawn } = structurePreview([newElement('p1', 'PLOT_BEAT', slot)], boxes, PLOT);
        expect(undrawn).toBe(0);
        expect(nodes).toEqual([expect.objectContaining({ proposalId: 'p1', x: 216 + GHOST_SIDE_OFFSET })]);
        const centre = nodes[0].y + nodes[0].h / 2;
        expect(centre).toBeGreaterThan(64 + 44);
        expect(centre).toBeLessThan(168 + 44);
    });

    it('a slot that has CHANGED is not drawn between its old neighbours (D25: the author chooses where it goes)', () => {
        const slot = { afterElementId: 'b1', afterName: 'One', beforeElementId: 'b2', beforeName: 'Two', act: 'opening', changed: 'GAP_FILLED' as const, choices: [], choicesTruncated: false };
        const { nodes } = structurePreview([newElement('p1', 'PLOT_BEAT', slot)], boxes, PLOT);
        expect(nodes).toEqual([expect.objectContaining({ proposalId: 'p1', x: 216 + 2 * GHOST_SIDE_OFFSET })]);
    });

    it('a new element with no slot, or whose neighbours are not on the map, goes in a column to the right', () => {
        const { nodes } = structurePreview(
            [newElement('p1', 'PLOT_BEAT'), newElement('p2', 'PLOT_BEAT', { afterElementId: 'gone', afterName: 'x', beforeElementId: 'b2', beforeName: 'y', act: null, changed: null, choices: [], choicesTruncated: false })],
            boxes,
            PLOT,
        );
        expect(nodes.map((n) => n.x)).toEqual([216 + 2 * GHOST_SIDE_OFFSET, 216 + 2 * GHOST_SIDE_OFFSET]);
        expect(nodes[1].y).toBeGreaterThan(nodes[0].y);
    });

    it('a kind this map does not draw, and a decided proposal, are not drawn; the first is counted', () => {
        const decided = { ...newElement('p2', 'PLOT_BEAT'), status: 'ACCEPTED' as const };
        const r = structurePreview([newElement('p1', 'CHARACTER'), decided], boxes, PLOT);
        expect(r.nodes).toEqual([]);
        expect(r.undrawn).toBe(1);
    });

    it('a new relation is a line between shown ends — a card or a ghost — and counted when an end is not shown', () => {
        const r = structurePreview(
            [newElement('p1', 'PLOT_BEAT'), newRelation('r1', { elementId: 'b1' }, { proposalId: 'p1' }), newRelation('r2', { elementId: 'b1' }, { elementId: 'b2' }), newRelation('r3', { elementId: 'b1' }, { elementId: 'not-on-map' })],
            boxes,
            PLOT,
        );
        expect(r.edges.map((e) => e.proposalId)).toEqual(['r1', 'r2']);
        expect(r.edges[1]).toMatchObject({ from: { x: 116, y: 108 }, to: { x: 116, y: 212 } });
        expect(r.undrawn).toBe(1);
    });
});

describe('betweenSlots', () => {
    const layout = deriveLaneLayout(
        'PLOT',
        [
            { elementId: 'a', name: 'A', orderRank: 'b', act: 'opening' },
            { elementId: 'b', name: 'B', orderRank: 'd', act: 'opening' },
            { elementId: 'c', name: 'C', orderRank: 'c', act: 'crisis' },
            { elementId: 'd', name: 'D', orderRank: 'f', act: 'opening' },
            { elementId: 'u', name: 'U', orderRank: null, act: 'opening' },
        ],
        { acts: [{ value: 'opening', label: 'Opening' }, { value: 'crisis', label: 'Crisis' }] },
    );

    it('offers each two consecutive placed beats of one act, skipping other acts and the unplaced', () => {
        expect(betweenSlots(layout).map((s) => `${s.afterElementId}>${s.beforeElementId}`)).toEqual(['a>b', 'b>d']);
    });

    it('stands its control in the gap between the two cards', () => {
        const [first] = betweenSlots(layout);
        const a = layout!.positions.get('a')!;
        const b = layout!.positions.get('b')!;
        expect(first.point.y).toBeGreaterThan(a.y + a.h - 1);
        expect(first.point.y).toBeLessThan(b.y + 1);
    });

    it('offers nothing on the timeline or the relationship map', () => {
        expect(betweenSlots(deriveLaneLayout('TIMELINE', [{ elementId: 'a', name: 'A', orderRank: 'b', act: null }, { elementId: 'b', name: 'B', orderRank: 'c', act: null }]))).toEqual([]);
        expect(betweenSlots(null)).toEqual([]);
    });
});

describe('the setup seam carries a canvas target', () => {
    const setup = { ...CODE_SETUP_DEFAULTS, personaKeys: [] };
    const roundTrip = (q: string) => setupFromQuery(Object.fromEntries(new URLSearchParams(q)));

    it('a selection and a slot survive the query and become the start body', () => {
        const selection = { scope: 'SELECTION' as const, elementIds: ['e1', 'e2'], relationIds: ['r1'] };
        expect(roundTrip(interviewSetupQuery(selection, setup))?.target).toEqual(selection);
        expect(startRequestBody(selection, setup)).toMatchObject({ scope: 'SELECTION', elementIds: ['e1', 'e2'], relationIds: ['r1'] });
        const edge = { scope: 'SELECTION' as const, elementIds: [], relationIds: ['r1'] };
        expect(roundTrip(interviewSetupQuery(edge, setup))?.target).toEqual(edge);
        const between = { scope: 'BETWEEN' as const, afterElementId: 'b1', beforeElementId: 'b2' };
        expect(roundTrip(interviewSetupQuery(between, setup))?.target).toEqual(between);
    });

    it('names no target for an empty or oversized selection, or a slot of one beat', () => {
        expect(roundTrip('scope=SELECTION')).toBeNull();
        const many = Array.from({ length: SELECTION_QUERY_MAX + 1 }, (_, i) => `e${i}`).join(',');
        expect(roundTrip(`scope=SELECTION&elements=${many}`)).toBeNull();
        expect(roundTrip('scope=BETWEEN&after=b1&before=b1')).toBeNull();
        expect(roundTrip('scope=BETWEEN&after=b1')).toBeNull();
    });
});
