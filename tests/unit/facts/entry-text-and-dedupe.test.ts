/**
 * The fact layer's pure core (Phase 4.1, D27): an accepted version as text, the
 * incremental "what changed" the call is shown, the claim key that keeps one
 * live fact per claim, and the resolution that proposes — never applies — an
 * invalidation.
 */
import { buildSnapshot } from '@/lib/bible/snapshot';
import { buildRelationSnapshot } from '@/lib/bible/relation-snapshot';
import { changedSections, entryText, renderElementEntry, renderRelationEntry, sentText } from '@/lib/facts/entry-text';
import { claimParts, resolveFacts, ruleContradicts, timesOverlap, type LiveFact, type NewFact } from '@/lib/facts/dedupe';

const wren = (summary: string, fields: Array<{ key: string; value: string | string[] | number; order: number }> = []) =>
    buildSnapshot({ element: { kind: 'CHARACTER', name: 'Wren', slug: 'wren', status: 'DRAFT', summary, customLabel: null }, fields });

describe('an accepted version as text', () => {
    it('renders a header and one line a section; a scale states nothing; a choice is read by its label', () => {
        const entry = renderElementEntry(
            wren('Wren is <b>12</b> years old.', [
                { key: 'role', value: 'The lock keeper’s daughter', order: 1 },
                { key: 'prominence', value: 'protagonist', order: 2 },
                { key: 'agency', value: 4, order: 8 },
                { key: 'defining_traits', value: ['stubborn', 'quick'], order: 3 },
            ]),
        );
        const text = entryText(entry);
        expect(text.split('\n')[0]).toBe('Name: Wren');
        expect(text.split('\n')[1]).toBe('Kind: Character');
        expect(text).toContain('Summary: Wren is 12 years old.');
        expect(text).toContain('stubborn; quick');
        expect(entry.body.map((s) => s.key)).not.toContain('agency');
        expect(text).not.toContain('<b>');
    });

    it('sends only the sections that changed since the baseline, after the header; with no baseline, all of them', () => {
        const before = renderElementEntry(wren('Wren is 12.', [{ key: 'want', value: 'Wren wants to cross the river.', order: 7 }]));
        const after = renderElementEntry(wren('Wren is 13.', [{ key: 'want', value: 'Wren wants to cross the river.', order: 7 }]));
        expect(changedSections(after, before).map((s) => s.key)).toEqual(['summary']);
        expect(changedSections(after, null).map((s) => s.key)).toEqual(['summary', 'want']);
        expect(sentText(after, changedSections(after, before))).toBe('Name: Wren\nKind: Character\nSummary: Wren is 13.');
        // A section only dropped is not sent: nothing new is stated by its absence.
        const cleared = renderElementEntry(wren('Wren is 13.'));
        expect(changedSections(cleared, after)).toEqual([]);
    });

    it('renders a relation between its two ends, named as the book names them', () => {
        const snap = buildRelationSnapshot({ relation: { type: 'related_to', fromElementId: 'a', toElementId: 'b', note: 'Osei has run the station for six years.' }, fields: [] });
        const text = entryText(renderRelationEntry(snap, { fromKind: 'CHARACTER', fromName: 'Commander Osei', toName: 'Station Kestrel' }));
        expect(text).toBe('Relation: Commander Osei — related to — Station Kestrel\nNote: Osei has run the station for six years.');
    });
});

describe('the claim', () => {
    const owner = { kind: 'BIBLE_VERSION' as const, id: 'el-1' };
    it('keeps polarity: "can not swim" is never the claim "can swim", though their content words are the same', () => {
        const a = claimParts(owner, { predicate: 'ABILITY', subjectElementId: 'el-1', objectLiteral: null, statement: 'Wren can not swim.' });
        const b = claimParts(owner, { predicate: 'ABILITY', subjectElementId: 'el-1', objectLiteral: null, statement: 'Wren can swim.' });
        expect(a).not.toEqual(b);
    });
    it('is the same claim across its wording’s accidents (case, punctuation, a plural)', () => {
        const a = claimParts(owner, { predicate: 'WANT', subjectElementId: 'el-1', objectLiteral: '', statement: 'Wren wants to cross the river.' });
        const b = claimParts(owner, { predicate: 'WANT', subjectElementId: 'el-1', objectLiteral: null, statement: 'wren WANTS to cross the river' });
        expect(a).toEqual(b);
    });
    it('belongs to its entry: the same words in another element or a relation are another claim', () => {
        const f = { predicate: 'WANT', subjectElementId: 'el-1', objectLiteral: null, statement: 'Wren wants to cross the river.' };
        expect(claimParts(owner, f)).not.toEqual(claimParts({ kind: 'RELATION_VERSION', id: 'rel-1' }, f));
        expect(claimParts(owner, f)).not.toEqual(claimParts({ kind: 'BIBLE_VERSION', id: 'el-2' }, f));
    });
});

const live = (id: string, over: Partial<LiveFact>): LiveFact => ({
    id,
    key: null,
    predicate: 'OTHER',
    subjectElementId: 'el-1',
    objectLiteral: null,
    statement: 'x',
    storyTimeFrom: null,
    storyTimeTo: null,
    quote: 'a quote long enough',
    sameOwner: false,
    ...over,
});
const fresh = (over: Partial<NewFact>): NewFact => ({ key: 'k', predicate: 'OTHER', subjectElementId: 'el-1', objectLiteral: null, statement: 'x', storyTimeFrom: null, storyTimeTo: null, contradicts: [], ...over });

describe('contradiction by rule', () => {
    it('an age that differs, at an overlapping time, contradicts; one at another stated time does not', () => {
        const twelve = live('a', { predicate: 'AGE', statement: 'Wren is 12 years old.' });
        expect(ruleContradicts(fresh({ predicate: 'AGE', statement: 'Wren is 13 years old.' }), twelve)).toBe(true);
        expect(ruleContradicts(fresh({ predicate: 'AGE', statement: 'Wren is 12.' }), twelve)).toBe(false);
        expect(ruleContradicts(fresh({ predicate: 'AGE', statement: 'Wren is 20.', storyTimeFrom: '1900' }), { ...twelve, storyTimeFrom: '1891' })).toBe(false);
    });
    it('a location that plainly differs contradicts; one that contains the other does not; a WANT never does', () => {
        const leeds = live('a', { predicate: 'LOCATION', objectLiteral: 'Leeds' });
        expect(ruleContradicts(fresh({ predicate: 'LOCATION', objectLiteral: 'Bradford' }), leeds)).toBe(true);
        expect(ruleContradicts(fresh({ predicate: 'LOCATION', objectLiteral: 'north Leeds' }), leeds)).toBe(false);
        expect(ruleContradicts(fresh({ predicate: 'WANT', objectLiteral: 'revenge' }), live('b', { predicate: 'WANT', objectLiteral: 'to cross the river' }))).toBe(false);
        // Another subject is never contradicted by rule.
        expect(ruleContradicts(fresh({ predicate: 'LOCATION', objectLiteral: 'Bradford', subjectElementId: 'el-2' }), leeds)).toBe(false);
    });
    it('times overlap when equal or either is unstated', () => {
        expect(timesOverlap(fresh({}), live('a', { storyTimeFrom: '1891' }))).toBe(true);
        expect(timesOverlap(fresh({ storyTimeFrom: 'The winter of 1891' }), live('a', { storyTimeFrom: 'the winter of 1891' }))).toBe(true);
        expect(timesOverlap(fresh({ storyTimeFrom: '1891' }), live('a', { storyTimeFrom: '1885' }))).toBe(false);
    });
});

describe('resolving a version', () => {
    const entry = 'Name: Wren\nKind: Character\nSummary: Wren is 13 years old and has never learned to swim.';
    it('a restated live fact gets provenance, not a twin; a new claim is inserted; a repeat within the version is counted once', () => {
        const restated = live('swim', { key: 'k-swim', sameOwner: true, quote: 'has never learned to swim' });
        const plan = resolveFacts({ fresh: [fresh({ key: 'k-swim' }), fresh({ key: 'k-new' }), fresh({ key: 'k-new' })], shown: [restated], live: [restated], entry });
        expect(plan.restated).toEqual([{ factId: 'swim', newIndex: 0 }]);
        expect(plan.insert).toEqual([1]);
        expect(plan.counts.duplicatesInVersion).toBe(1);
    });

    it('proposes a contradiction by rule and by the model, never for a fact the version restates, and never one the model names of another subject', () => {
        const twelve = live('age', { key: 'k-age12', predicate: 'AGE', statement: 'Wren is 12 years old.', sameOwner: true, quote: 'Wren is 12 years old' });
        const member = live('member', { key: null, predicate: 'MEMBERSHIP', statement: 'Only clerks may join.', quote: 'Only clerks may join the guild' });
        const other = live('other', { subjectElementId: 'el-9', quote: 'Someone else entirely here' });
        const plan = resolveFacts({
            fresh: [fresh({ key: 'k-age13', predicate: 'AGE', statement: 'Wren is 13 years old.', contradicts: [1, 2] })],
            shown: [twelve, member, other],
            live: [twelve, member, other],
            entry,
        });
        expect(plan.contradictions).toEqual(
            expect.arrayContaining([
                { olderId: 'age', newIndex: 0, basis: 'RULE' },
                { olderId: 'member', newIndex: 0, basis: 'MODEL' },
            ]),
        );
        expect(plan.contradictions.map((c) => c.olderId)).not.toContain('other');
        expect(plan.counts.modelOtherSubject).toBe(1);
        // The contradicted fact is not also proposed as no longer stated (its quote is gone): one proposal, the right one.
        expect(plan.noLongerStated).not.toContain('age');
    });

    it('proposes, by its text, an earlier fact of the same entry the version no longer states — and no other entry’s', () => {
        const scar = live('scar', { key: 'k-scar', sameOwner: true, quote: 'a burn scar across her left hand' });
        const kept = live('kept', { key: 'k-kept', sameOwner: true, quote: 'has never learned to swim' });
        const foreign = live('foreign', { key: null, sameOwner: false, quote: 'a quote that is nowhere' });
        const plan = resolveFacts({ fresh: [], shown: [], live: [scar, kept, foreign], entry });
        expect(plan.noLongerStated).toEqual(['scar']);
    });
});
