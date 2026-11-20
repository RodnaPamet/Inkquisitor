/**
 * THE FRONTIER ADDRESSES A RELATION'S FIELDS (Phase 3.3, D24; rule 5). A
 * relation is a subject of its own, keyed by its id, its fields its type's
 * template fields: a field the relation already holds is answered by the
 * bible and never asked; one that depends on an empty field waits for it; a
 * BETWEEN slot's act is answered by the slot (`between-slot`).
 */
import { relationFieldDefs, getTemplate } from '@/lib/bible/templates';
import { computeFrontier, refsCheck } from '@/lib/interview/frontier';
import { PENDING_SUBJECT_ID } from '@/lib/interview/subjects';

const relation = (storedKeys: string[]) => ({ elementId: 'rel-1', kind: 'CHARACTER' as const, fields: relationFieldDefs('CHARACTER', 'loves'), storedKeys: new Set(storedKeys) });

describe('a relation subject', () => {
    it('asks every core field it does not hold, by the relation’s id', () => {
        const r = computeFrontier({ elements: [relation([])], sessionAnswers: [], depth: 2 });
        expect(r.frontier.map((f) => `${f.elementId}:${f.fieldKey}`)).toEqual(expect.arrayContaining(['rel-1:history', 'rel-1:wants']));
        // `unspoken` depends on the empty `history`: it waits.
        expect(r.frontier.map((f) => f.fieldKey)).not.toContain('unspoken');
        expect(r.blocked.map((b) => b.fieldKey)).toContain('unspoken');
    });

    it('never asks what the relation already holds, and opens what that unblocks', () => {
        const r = computeFrontier({ elements: [relation(['history'])], sessionAnswers: [], depth: 2 });
        expect(r.frontier.map((f) => f.fieldKey)).not.toContain('history');
        expect(r.answered).toEqual([expect.objectContaining({ elementId: 'rel-1', fieldKey: 'history', by: 'bible-values' })]);
        expect(r.frontier.map((f) => f.fieldKey)).toContain('unspoken');
    });

    it('an answer of this session about a relation field satisfies it', () => {
        const r = computeFrontier({ elements: [relation([])], sessionAnswers: [{ status: 'ANSWERED', targets: [{ elementId: 'rel-1', fieldKey: 'wants' }] }], depth: 2 });
        expect(r.frontier.map((f) => f.fieldKey)).not.toContain('wants');
        expect(r.answeredInSession).toEqual([{ elementId: 'rel-1', fieldKey: 'wants' }]);
    });
});

describe('the element not yet created (a BETWEEN slot)', () => {
    it('is asked its fields, except the act the slot already says', () => {
        const pending = { elementId: PENDING_SUBJECT_ID, kind: 'PLOT_BEAT' as const, fields: getTemplate('PLOT_BEAT').fields, storedKeys: new Set<string>() };
        const without = computeFrontier({ elements: [pending], sessionAnswers: [{ status: 'ANSWERED', targets: [{ elementId: PENDING_SUBJECT_ID, fieldKey: 'what_happens' }] }], depth: 5 });
        expect(without.frontier.map((f) => f.fieldKey)).toContain('act');
        const r = computeFrontier({ elements: [pending], sessionAnswers: [{ status: 'ANSWERED', targets: [{ elementId: PENDING_SUBJECT_ID, fieldKey: 'what_happens' }] }], depth: 5, checks: [refsCheck('between-slot', [{ elementId: PENDING_SUBJECT_ID, fieldKey: 'act' }])] });
        expect(r.frontier.map((f) => f.fieldKey)).not.toContain('act');
        expect(r.answered).toEqual([expect.objectContaining({ fieldKey: 'act', by: 'between-slot' })]);
        expect(r.frontier.length).toBeGreaterThan(0);
    });
});
