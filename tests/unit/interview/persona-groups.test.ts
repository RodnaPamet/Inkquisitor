/** Questions grouped by who asked (Phase 4.3, D29: persona panels). Pure. */
import { groupByPersona, groupsNeedHeadings } from '@/lib/interview/persona-groups';

const q = (id: string, personaKey: string | null) => ({ id, personaKey });

it('groups a panel’s questions by persona in the order each first asked, keeping each question’s place', () => {
    const groups = groupByPersona([q('1', 'panel-target-reader'), q('2', 'panel-ruthless-editor'), q('3', 'panel-target-reader'), q('4', null), q('5', 'panel-genre-specialist')]);
    expect(groups.map((g) => [g.personaKey, g.items.map((x) => x.id)])).toEqual([
        ['panel-target-reader', ['1', '3']],
        ['panel-ruthless-editor', ['2']],
        [null, ['4']],
        ['panel-genre-specialist', ['5']],
    ]);
    expect(groupsNeedHeadings(groups)).toBe(true);
});

it('one persona (or none) is one group shown with no heading', () => {
    const one = groupByPersona([q('1', 'socratic'), q('2', 'socratic')]);
    expect(one).toHaveLength(1);
    expect(groupsNeedHeadings(one)).toBe(false);
    expect(groupByPersona([])).toEqual([{ personaKey: null, items: [] }]);
});
