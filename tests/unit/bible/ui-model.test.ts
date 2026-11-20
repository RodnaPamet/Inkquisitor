/**
 * What the bible pages hand the browser about the templates (Phase 1.2):
 * the kinds with their field counts, and the relation options an element's
 * page offers — exactly the relations the API would accept from that end.
 */
import { BIBLE_KINDS, type BibleKind } from '@/lib/bible/kinds';
import { getTemplate, relationAllowed } from '@/lib/bible/templates';
import { kindSummaries, relationOptionsFor } from '@/lib/bible/ui-model';
import { SCALE_MAX, SCALE_MIN } from '@/lib/bible/field-values';
import { SCALE_STEPS } from '@/components/bible/FieldEditor';

describe('kindSummaries', () => {
    it('lists every kind in the fixed order with its template field count', () => {
        const summaries = kindSummaries();
        expect(summaries.map((s) => s.kind)).toEqual([...BIBLE_KINDS]);
        for (const s of summaries) expect(s.fieldCount).toBe(getTemplate(s.kind).fields.length);
    });
});

describe('relationOptionsFor', () => {
    it.each(BIBLE_KINDS.map((k) => [k]))('every option for %s is a relation the API accepts, from the end it names', (kind: BibleKind) => {
        const options = relationOptionsFor(kind);
        expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
        for (const o of options) {
            for (const other of o.otherKinds) {
                const [from, to] = o.direction === 'outgoing' ? [kind, other] : [other, kind];
                expect([o.id, other, relationAllowed(from, o.type, to)]).toEqual([o.id, other, true]);
            }
        }
    });

    it('reads a relation another kind declares with its inverse label', () => {
        const member = relationOptionsFor('FACTION').find((o) => o.type === 'member_of' && o.direction === 'incoming');
        expect(member).toEqual({ id: 'in:CHARACTER:member_of', type: 'member_of', label: 'has member', direction: 'incoming', otherKinds: ['CHARACTER'], symmetric: false });
    });

    it('offers a symmetric type a kind declares towards itself once, and a directed one from both ends', () => {
        const character = relationOptionsFor('CHARACTER');
        expect(character.filter((o) => o.type === 'sibling_of')).toHaveLength(1);
        expect(character.filter((o) => o.type === 'mentor_of').map((o) => o.label).sort()).toEqual(['mentor of', 'mentored by']);
    });

    it('always offers the built-in relation to any kind', () => {
        expect(relationOptionsFor('CUSTOM').find((o) => o.type === 'related_to')?.otherKinds).toEqual([...BIBLE_KINDS]);
    });
});

it('the scale editor offers exactly the steps the API accepts', () => {
    expect(SCALE_STEPS.map(Number)).toEqual(Array.from({ length: SCALE_MAX - SCALE_MIN + 1 }, (_, i) => SCALE_MIN + i));
});
