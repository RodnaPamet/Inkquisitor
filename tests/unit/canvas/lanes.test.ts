/**
 * The derived maps' layout (Phase 3.2, decision D22): the plot board's act
 * lanes and the timeline's axis and character lanes come from the bible's act
 * and story order, and a drop is read back as the order move it asks for.
 */
import { compareRanks } from '@/lib/bible/story-order';
import { LANE_CARD_H, LANE_CARD_W, NO_ACT_LANE, PLACED_LANE, UNPLACED_LANE, deriveLaneLayout, dropTarget, sequenceOf, stepMove, type LaneLayout, type LaneNodeInput } from '@/lib/canvas/lanes';

const ACTS = [
    { value: 'opening', label: 'Opening' },
    { value: 'escalation', label: 'Escalation' },
    { value: 'crisis', label: 'Crisis' },
];

const beat = (elementId: string, act: string | null, orderRank: string | null, name = elementId): LaneNodeInput => ({ elementId, name, act, orderRank });
const event = (elementId: string, orderRank: string | null, name = elementId): LaneNodeInput => ({ elementId, name, act: null, orderRank });

const centre = (layout: LaneLayout, id: string) => {
    const p = layout.positions.get(id)!;
    return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
};

describe('the plot board', () => {
    const beats = [beat('b1', 'opening', 'm'), beat('b2', 'opening', 'c'), beat('b3', 'escalation', 'k'), beat('b4', 'opening', null, 'Alpha'), beat('b5', null, 'z'), beat('b6', 'crisis', null)];
    const layout = deriveLaneLayout('PLOT', beats, { acts: ACTS })!;

    it('puts each beat in its act’s lane, a beat with no act in a last lane of its own', () => {
        expect(layout.bands.map((b) => b.key)).toEqual(['opening', 'escalation', 'crisis', NO_ACT_LANE]);
        expect(layout.positions.get('b3')!.lane).toBe('escalation');
        expect(layout.positions.get('b5')!.lane).toBe(NO_ACT_LANE);
        const columns = [...new Set(['b1', 'b3', 'b6', 'b5'].map((id) => layout.positions.get(id)!.x))];
        expect(columns).toHaveLength(4);
    });

    it('orders a lane by rank, the unplaced after the placed, and stacks cards top to bottom', () => {
        expect(layout.sequences.get('opening')!.map((n) => n.elementId)).toEqual(['b2', 'b1', 'b4']);
        const ys = ['b2', 'b1', 'b4'].map((id) => layout.positions.get(id)!.y);
        expect(ys).toEqual([...ys].sort((a, b) => a - b));
        expect(new Set(ys).size).toBe(3);
        for (const p of layout.positions.values()) expect([p.w, p.h]).toEqual([LANE_CARD_W, LANE_CARD_H]);
    });

    it('has no no-act lane when every beat has an act, and draws empty act lanes', () => {
        const all = deriveLaneLayout('PLOT', [beat('x', 'crisis', 'a')], { acts: ACTS })!;
        expect(all.bands.map((b) => b.key)).toEqual(['opening', 'escalation', 'crisis']);
    });

    it('the relationship map is not derived', () => {
        expect(deriveLaneLayout('RELATIONSHIP', beats)).toBeNull();
    });

    it('a drop between two cards of the lane names them; at the top, the first card; in another lane, the act', () => {
        const between = { x: centre(layout, 'b2').x, y: (centre(layout, 'b2').y + centre(layout, 'b1').y) / 2 };
        expect(dropTarget(layout, 'b3', between, { act: 'escalation', orderRank: 'k' })).toEqual({ elementId: 'b3', after: 'b2', before: 'b1', act: 'opening' });
        const top = { x: centre(layout, 'b2').x, y: 0 };
        expect(dropTarget(layout, 'b1', top, { act: 'opening', orderRank: 'm' })).toEqual({ elementId: 'b1', after: null, before: 'b2' });
    });

    it('a drop below the placed cards places it after the last placed one (an unplaced card has no rank to sit beside)', () => {
        const bottom = { x: centre(layout, 'b4').x, y: centre(layout, 'b4').y + 400 };
        expect(dropTarget(layout, 'b3', bottom, { act: 'escalation', orderRank: 'k' })).toEqual({ elementId: 'b3', after: 'b1', before: null, act: 'opening' });
        // An unplaced beat dropped back at the end of its own lane is placed there.
        expect(dropTarget(layout, 'b4', bottom, { act: 'opening', orderRank: null })).toEqual({ elementId: 'b4', after: 'b1', before: null });
    });

    it('asks for nothing when a card is dropped back in its own place, in no lane, or into the no-act lane', () => {
        expect(dropTarget(layout, 'b1', centre(layout, 'b1'), { act: 'opening', orderRank: 'm' })).toBeNull();
        expect(dropTarget(layout, 'b1', { x: -500, y: 10 }, { act: 'opening', orderRank: 'm' })).toBeNull();
        expect(dropTarget(layout, 'b1', centre(layout, 'b5'), { act: 'opening', orderRank: 'm' })).toBeNull();
    });

    it('the keyboard moves one place within the lane, and stops at its ends', () => {
        expect(stepMove(layout, 'b1', 'earlier')).toEqual({ elementId: 'b1', after: null, before: 'b2' });
        expect(stepMove(layout, 'b2', 'later')).toEqual({ elementId: 'b2', after: 'b1', before: null });
        expect(stepMove(layout, 'b2', 'earlier')).toBeNull();
        expect(stepMove(layout, 'b1', 'later')).toBeNull();
        // An unplaced beat: "Later" places it after its lane's last placed beat; "Earlier" does nothing.
        expect(stepMove(layout, 'b4', 'later')).toEqual({ elementId: 'b4', after: 'b1', before: null });
        expect(stepMove(layout, 'b4', 'earlier')).toBeNull();
    });
});

describe('the timeline', () => {
    const events = [event('e1', 'q'), event('e2', 'c'), event('e3', null, 'Bravo'), event('e4', null, 'Alpha'), event('e5', 'j')];
    const participants = new Map([
        ['e5', [{ id: 'c-ada', name: 'Ada' }]],
        ['e2', [{ id: 'c-bo', name: 'Bo' }]],
        ['e1', [{ id: 'c-ada', name: 'Ada' }, { id: 'c-bo', name: 'Bo' }]],
        ['e4', [{ id: 'c-cy', name: 'Cy' }]],
    ]);
    const layout = deriveLaneLayout('TIMELINE', events, { participants })!;

    it('places events left to right in story order, the unplaced after a gap, all in one row', () => {
        const placed = ['e2', 'e5', 'e1'].map((id) => layout.positions.get(id)!);
        expect(placed.map((p) => p.lane)).toEqual([PLACED_LANE, PLACED_LANE, PLACED_LANE]);
        expect(placed.map((p) => p.x)).toEqual([...placed.map((p) => p.x)].sort((a, b) => a - b));
        const unplaced = ['e4', 'e3'].map((id) => layout.positions.get(id)!);
        expect(unplaced.map((p) => p.lane)).toEqual([UNPLACED_LANE, UNPLACED_LANE]);
        expect(unplaced[0].x - placed[2].x).toBeGreaterThan(LANE_CARD_W * 1.5);
        expect(new Set([...layout.positions.values()].map((p) => p.y)).size).toBe(1);
    });

    it('gives each character taking part a lane, in the order of their first event, with a mark under each of their events', () => {
        const characterBands = layout.bands.filter((b) => b.role === 'character');
        expect(characterBands.map((b) => b.label)).toEqual(['Bo', 'Ada', 'Cy']);
        const marksOf = (id: string) => layout.marks.filter((m) => m.characterId === id).map((m) => m.elementId);
        expect(marksOf('c-bo')).toEqual(['e2', 'e1']);
        expect(marksOf('c-ada')).toEqual(['e5', 'e1']);
        expect(marksOf('c-cy')).toEqual(['e4']);
        // A mark sits under its event, in its character's lane.
        const mark = layout.marks.find((m) => m.characterId === 'c-ada' && m.elementId === 'e5')!;
        expect(mark.x).toBe(centre(layout, 'e5').x);
        const band = characterBands.find((b) => b.key === 'character:c-ada')!;
        expect(mark.y > band.y && mark.y < band.y + band.h).toBe(true);
    });

    it('a drop on the axis is a move between the placed events either side; in the unplaced zone, nothing', () => {
        const between = { x: (centre(layout, 'e2').x + centre(layout, 'e5').x) / 2, y: centre(layout, 'e2').y };
        expect(dropTarget(layout, 'e1', between, { act: null, orderRank: 'q' })).toEqual({ elementId: 'e1', after: 'e2', before: 'e5' });
        expect(dropTarget(layout, 'e3', { x: 0, y: 0 }, { act: null, orderRank: null })).toEqual({ elementId: 'e3', after: null, before: 'e2' });
        expect(dropTarget(layout, 'e1', centre(layout, 'e3'), { act: null, orderRank: 'q' })).toBeNull();
        expect(dropTarget(layout, 'e5', centre(layout, 'e5'), { act: null, orderRank: 'j' })).toBeNull();
    });

    it('with nothing placed yet, the empty first slot is where the first event goes', () => {
        const fresh = deriveLaneLayout('TIMELINE', [event('a', null), event('b', null)])!;
        const axis = fresh.bands.find((b) => b.role === 'axis')!;
        expect(dropTarget(fresh, 'b', { x: axis.x + axis.w / 2, y: 60 }, { act: null, orderRank: null })).toEqual({ elementId: 'b', after: null, before: null });
        expect(stepMove(fresh, 'a', 'later')).toEqual({ elementId: 'a', after: null, before: null });
    });
});

it('sequenceOf is a total order: rank, then name, then id', () => {
    const seq = sequenceOf([event('z', null, 'Same'), event('a', null, 'Same'), event('m', 'b'), event('n', 'a')]);
    expect(seq.map((n) => n.elementId)).toEqual(['n', 'm', 'a', 'z']);
    expect(compareRanks('a', 'b')).toBeLessThan(0);
});
