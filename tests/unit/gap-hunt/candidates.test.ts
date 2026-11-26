/**
 * THE GAP HUNT'S CANDIDATES (Phase 4.3, D29): computed by code, before any
 * model: how much the rest of the book depends on a field, and how empty it is.
 */
import { getTemplate } from '@/lib/bible/templates';
import { computeGapCandidates, dependentsOf, gapWeight } from '@/lib/gap-hunt/candidates';
import { GAP_CANDIDATES_MAX } from '@/lib/gap-hunt/vocabulary';

const NONE = new Map();

it('counts dependents transitively from the template’s dependsOn', () => {
    const fields = [
        { key: 'a', dependsOn: [] },
        { key: 'b', dependsOn: ['a'] },
        { key: 'c', dependsOn: ['b'] },
        { key: 'd', dependsOn: [] },
    ];
    expect(dependentsOf(fields, 'a')).toBe(2);
    expect(dependentsOf(fields, 'b')).toBe(1);
    expect(dependentsOf(fields, 'd')).toBe(0);
    // The premise's central conflict holds up most of the template.
    expect(dependentsOf(getTemplate('PREMISE').fields, 'central_conflict')).toBeGreaterThan(5);
});

it('scores by dependence × emptiness: a field no element leaves empty is never a candidate', () => {
    const all = new Set(getTemplate('THEME').fields.map((f) => f.key));
    expect(computeGapCandidates({ elements: [{ id: 'e1', kind: 'THEME', filledKeys: all }], signals: NONE, template: getTemplate })).toEqual([]);
    const one = computeGapCandidates({ elements: [{ id: 'e1', kind: 'THEME', filledKeys: new Set(['subject', 'thematic_question']) }], signals: NONE, template: getTemplate });
    expect(one[0]).toMatchObject({ n: 1, kind: 'THEME', fieldKey: 'stance', empty: 1, elements: 1 });
    expect(one.every((c) => c.fieldKey !== 'subject')).toBe(true);
});

it('a field more of the book depends on outranks one fewer depend on, at the same emptiness', () => {
    // The premise's central conflict holds up most of the template; a leaf field holds up nothing.
    const fields = getTemplate('PREMISE').fields;
    const leaf = { key: 'known_weaknesses' };
    expect(dependentsOf(fields, leaf.key)).toBe(0);
    const ranked = computeGapCandidates({ elements: [{ id: 'p1', kind: 'PREMISE', filledKeys: new Set<string>() }], signals: NONE, template: getTemplate }, 50);
    const conflict = ranked.find((c) => c.fieldKey === 'central_conflict')!;
    const other = ranked.find((c) => c.fieldKey === leaf.key)!;
    expect(conflict.dependents).toBeGreaterThan(other.dependents);
    expect(conflict.score).toBeGreaterThan(other.score);
    expect(conflict.n).toBeLessThan(other.n);
    expect(gapWeight({ dependents: 3, required: false, relations: 0, facts: 0, citations: 0 })).toBeGreaterThan(gapWeight({ dependents: 0, required: true, relations: 0, facts: 0, citations: 0 }));
});

it('a field half the elements fill scores half; relations, facts and citations weigh a kind up', () => {
    const elements = [
        { id: 'c1', kind: 'CHARACTER' as const, filledKeys: new Set(['role', 'want']) },
        { id: 'c2', kind: 'CHARACTER' as const, filledKeys: new Set(['role']) },
    ];
    const plain = computeGapCandidates({ elements, signals: NONE, template: getTemplate }, 50);
    const want = plain.find((c) => c.fieldKey === 'want')!;
    expect(want).toMatchObject({ empty: 1, elements: 2, emptyElementIds: ['c2'] });
    expect(want.score).toBe(gapWeight(want) / 2);
    const weighted = computeGapCandidates({ elements, signals: new Map([['CHARACTER', { relations: 4, facts: 2, citations: 3 }]]), template: getTemplate }, 50);
    expect(weighted.find((c) => c.fieldKey === 'want')!.score).toBeGreaterThan(want.score);
});

it('ranks by score, then the kind’s order, then the field’s, numbering the top ones from 1; deterministic', () => {
    const elements = [
        { id: 'p1', kind: 'PREMISE' as const, filledKeys: new Set(['central_character']) },
        { id: 't1', kind: 'THEME' as const, filledKeys: new Set<string>() },
    ];
    const a = computeGapCandidates({ elements, signals: NONE, template: getTemplate });
    const b = computeGapCandidates({ elements: [...elements].reverse(), signals: NONE, template: getTemplate });
    expect(a).toEqual(b);
    expect(a.length).toBe(GAP_CANDIDATES_MAX);
    expect(a.map((c) => c.n)).toEqual(Array.from({ length: GAP_CANDIDATES_MAX }, (_, i) => i + 1));
    for (let i = 1; i < a.length; i++) expect(a[i - 1].score).toBeGreaterThanOrEqual(a[i].score);
});

it('a book with no element has no candidate (rule 6: nothing measured, never "no gaps")', () => {
    expect(computeGapCandidates({ elements: [], signals: NONE, template: getTemplate })).toEqual([]);
});
