/**
 * The type picker's choices (Phase 3.2): what an arrow between two nodes may
 * become is exactly what the two kinds' templates declare, plus `related_to`,
 * stored from the declaring kind's end; a symmetric type is offered once; a
 * relation the pair already holds is not offered again. And each map draws
 * only its own kinds.
 */
import { relationOptionsFor } from '@/lib/bible/ui-model';
import { relationPickerChoices } from '@/lib/canvas/relation-picker';
import { MAP_ELEMENT_KINDS, mapLayoutMode, mapTakesKind, mapsDrawingKind } from '@/lib/canvas/map-kinds';

const A = { id: 'mara', kind: 'CHARACTER' };
const B = { id: 'guild', kind: 'FACTION' };
const C = { id: 'tam', kind: 'CHARACTER' };

describe('relationPickerChoices', () => {
    it('a character towards a faction: what CHARACTER declares towards FACTION, stored from the character, and related to', () => {
        const choices = relationPickerChoices({ a: A, b: B }, relationOptionsFor('CHARACTER'), []);
        expect(choices.map((c) => c.type).sort()).toEqual(['allied_with', 'answers_to', 'member_of', 'opposes', 'related_to'].sort());
        for (const c of choices) expect([c.fromElementId, c.toElementId]).toEqual(['mara', 'guild']);
        expect(choices.find((c) => c.type === 'member_of')!.label).toBe('member of');
        // A type CHARACTER declares towards CHARACTER only is not offered towards a faction.
        expect(choices.some((c) => c.type === 'mentor_of')).toBe(false);
    });

    it('drawn the other way, the same relations are offered read from the faction, and still stored from the character (the declaring end)', () => {
        const choices = relationPickerChoices({ a: B, b: A }, relationOptionsFor('FACTION'), []);
        const member = choices.find((c) => c.type === 'member_of')!;
        expect(member).toMatchObject({ label: 'has member', fromElementId: 'mara', toElementId: 'guild', symmetric: false });
        // FACTION's own types target FACTION or OBJECT only: none is offered towards a character.
        expect(choices.some((c) => c.type === 'front_for')).toBe(false);
        expect(choices.find((c) => c.type === 'related_to')).toMatchObject({ fromElementId: 'guild', toElementId: 'mara' });
    });

    it('two characters: a directed type both ways round, a symmetric one once', () => {
        const choices = relationPickerChoices({ a: A, b: C }, relationOptionsFor('CHARACTER'), []);
        const mentor = choices.filter((c) => c.type === 'mentor_of');
        expect(mentor.map((c) => [c.label, c.fromElementId, c.toElementId])).toEqual([
            ['mentor of', 'mara', 'tam'],
            ['mentored by', 'tam', 'mara'],
        ]);
        expect(choices.filter((c) => c.type === 'sibling_of')).toHaveLength(1);
    });

    it('leaves out what the pair already holds: the same way round, or a symmetric type either way', () => {
        const held = [
            { type: 'mentor_of', sourceElementId: 'mara', targetElementId: 'tam' },
            { type: 'sibling_of', sourceElementId: 'tam', targetElementId: 'mara' },
        ];
        const choices = relationPickerChoices({ a: A, b: C }, relationOptionsFor('CHARACTER'), held);
        expect(choices.filter((c) => c.type === 'mentor_of').map((c) => c.label)).toEqual(['mentored by']);
        expect(choices.some((c) => c.type === 'sibling_of')).toBe(false);
    });

    it('plot beats offer their causal types', () => {
        const choices = relationPickerChoices({ a: { id: 'b1', kind: 'PLOT_BEAT' }, b: { id: 'b2', kind: 'PLOT_BEAT' } }, relationOptionsFor('PLOT_BEAT'), []);
        expect(choices.filter((c) => c.fromElementId === 'b1').map((c) => c.type)).toEqual(expect.arrayContaining(['causes', 'enables', 'sets_up', 'undoes', 'related_to']));
        expect(choices.find((c) => c.type === 'causes' && c.fromElementId === 'b2')!.label).toBe('caused by');
    });
});

describe('each map draws its own kinds', () => {
    it('the relationship map characters and factions, the plot board beats, the timeline events', () => {
        expect(MAP_ELEMENT_KINDS).toEqual({ RELATIONSHIP: ['CHARACTER', 'FACTION'], PLOT: ['PLOT_BEAT'], TIMELINE: ['TIMELINE_EVENT'] });
        expect(mapTakesKind('PLOT', 'CHARACTER')).toBe(false);
        expect(mapTakesKind('TIMELINE', 'TIMELINE_EVENT')).toBe(true);
        expect(mapsDrawingKind('FACTION')).toEqual(['RELATIONSHIP']);
        expect(mapsDrawingKind('SETTING')).toEqual([]);
        expect([mapLayoutMode('RELATIONSHIP'), mapLayoutMode('PLOT'), mapLayoutMode('TIMELINE')]).toEqual(['free', 'derived', 'derived']);
    });
});
