/**
 * The rule detectors and the story clock (Phase 4.2, D28; D25): pure, so every
 * rule and every near miss is held here, and the story order is read from the
 * rank alone (one free order per book and kind), never from an act.
 */
import { detectRuleContradictions, propositionKey, ruleContradiction, type RuleFact } from '@/lib/continuity/rules';
import { before, decidedOverlap, NO_ORDER, overlaps, storyClock } from '@/lib/continuity/story-clock';

let n = 0;
function fact(over: Partial<RuleFact> & Pick<RuleFact, 'predicate' | 'statement'>): RuleFact {
    n++;
    return { id: `f${n}`, subjectElementId: 'wren', objectLiteral: null, storyTimeFrom: null, storyTimeTo: null, ownerElementId: null, ...over };
}

// Two plot beats and a timeline event. The ranks alone order them: "late" is in Act 1 yet after "early" in Act 2 (D25).
const clock = storyClock([
    { id: 'beat-early', kind: 'PLOT_BEAT', name: 'The Flood', orderRank: 'b' },
    { id: 'beat-late', kind: 'PLOT_BEAT', name: 'The Trial', orderRank: 'm' },
    { id: 'event-1', kind: 'TIMELINE_EVENT', name: 'The Wedding', orderRank: 'a' },
    { id: 'unplaced', kind: 'PLOT_BEAT', name: 'Drift', orderRank: '' },
]);

describe('the story clock', () => {
    it('places a fact by its own ordered entry, else by a story time naming one placed element', () => {
        expect(clock.positionOf({ ownerElementId: 'beat-late', storyTimeFrom: null, storyTimeTo: null })?.elementId).toBe('beat-late');
        expect(clock.positionOf({ storyTimeFrom: 'the flood', storyTimeTo: null })?.elementId).toBe('beat-early');
        // A range between two elements is not a point; an unplaced element and an unknown name place nothing.
        expect(clock.positionOf({ storyTimeFrom: 'The Flood', storyTimeTo: 'The Trial' })).toBeNull();
        expect(clock.positionOf({ storyTimeFrom: 'Drift', storyTimeTo: null })).toBeNull();
        expect(clock.positionOf({ storyTimeFrom: 'winter of 1203', storyTimeTo: null })).toBeNull();
    });

    it('two positions in one order overlap only at the same element; across orders, or with none, the stated times decide', () => {
        const atEarly = { ownerElementId: 'beat-early', storyTimeFrom: null, storyTimeTo: null };
        const atLate = { ownerElementId: 'beat-late', storyTimeFrom: null, storyTimeTo: null };
        const atEvent = { ownerElementId: 'event-1', storyTimeFrom: 'spring', storyTimeTo: null };
        expect(overlaps(atEarly, atEarly, clock)).toBe(true);
        expect(overlaps(atEarly, atLate, clock)).toBe(false);
        // A beat and a timeline event are in different orders: each is at a known point the clock cannot compare, so
        // only stated times on BOTH decide (4.H-b, the precision set's cross-order near miss); one unstated is no overlap.
        expect(overlaps(atEarly, atEvent, clock)).toBe(false);
        expect(overlaps({ ...atEarly, storyTimeFrom: 'spring' }, atEvent, clock)).toBe(true);
        expect(overlaps({ ...atEarly, storyTimeFrom: 'autumn' }, atEvent, clock)).toBe(false);
        expect(overlaps({ storyTimeFrom: 'spring', storyTimeTo: null }, { storyTimeFrom: 'autumn', storyTimeTo: null }, NO_ORDER)).toBe(false);
    });

    it('before and after come from the rank alone, within one order', () => {
        const early = { ownerElementId: 'beat-early', storyTimeFrom: null, storyTimeTo: null };
        const late = { ownerElementId: 'beat-late', storyTimeFrom: null, storyTimeTo: null };
        const event = { ownerElementId: 'event-1', storyTimeFrom: null, storyTimeTo: null };
        expect(before(early, late, clock)).toBe(true);
        expect(before(late, early, clock)).toBe(false);
        expect(before(event, early, clock)).toBe(false);
        expect(before(early, event, clock)).toBe(false);
        expect(before(early, late, NO_ORDER)).toBe(false);
    });
});

describe('the rule detectors', () => {
    it('VALUE: an age that differs at an overlapping time; never at two story positions', () => {
        const twelve = fact({ predicate: 'AGE', statement: 'Wren is 12 years old.', objectLiteral: '12 years old' });
        const thirteen = fact({ predicate: 'AGE', statement: 'Wren is 13 years old.', objectLiteral: '13 years old' });
        expect(ruleContradiction(twelve, thirteen)).toBe('VALUE');
        const atEarly = { ...twelve, ownerElementId: 'beat-early' };
        const atLate = { ...thirteen, ownerElementId: 'beat-late' };
        expect(ruleContradiction(atEarly, atLate, clock)).toBeNull();
        expect(ruleContradiction(atEarly, { ...atLate, ownerElementId: 'beat-early' }, clock)).toBe('VALUE');
    });

    it('WHEREABOUTS: two places at the same beat; a place and its part are not two places', () => {
        const mill = fact({ predicate: 'LOCATION', statement: 'Wren is at the mill.', objectLiteral: 'the mill', ownerElementId: 'beat-late' });
        const city = fact({ predicate: 'LOCATION', statement: 'Wren is in the city.', objectLiteral: 'the city', ownerElementId: 'beat-late' });
        const cityLater = { ...city, id: 'later', ownerElementId: 'beat-early' };
        expect(ruleContradiction(mill, city, clock)).toBe('WHEREABOUTS');
        expect(ruleContradiction(mill, cityLater, clock)).toBeNull();
        const millYard = fact({ predicate: 'LOCATION', statement: 'Wren is in the mill yard.', objectLiteral: 'the mill yard', ownerElementId: 'beat-late' });
        expect(ruleContradiction(mill, millYard, clock)).toBeNull();
        // Two stated times that agree clash too.
        const inMay = fact({ predicate: 'LOCATION', statement: 'Wren is at the mill.', objectLiteral: 'the mill', storyTimeFrom: 'May' });
        expect(ruleContradiction(inMay, { ...city, ownerElementId: null, storyTimeFrom: 'May' })).toBe('WHEREABOUTS');
    });

    it('WHEREABOUTS (D28 addendum): a place with no time and no position clashes with nothing by rule, dated or not', () => {
        const undated = fact({ predicate: 'LOCATION', statement: 'Wren is at the mill.', objectLiteral: 'the mill' });
        const alsoUndated = fact({ predicate: 'LOCATION', statement: 'Wren is in the city.', objectLiteral: 'the city' });
        const placed = { ...alsoUndated, id: 'placed', ownerElementId: 'beat-late' };
        const dated = { ...alsoUndated, id: 'dated', storyTimeFrom: 'May' };
        expect(ruleContradiction(undated, alsoUndated, clock)).toBeNull();
        expect(ruleContradiction(undated, placed, clock)).toBeNull();
        expect(ruleContradiction(undated, dated, clock)).toBeNull();
        // A traveller's many undated whereabouts make no pair at all.
        const many = Array.from({ length: 50 }, (_, i) => fact({ predicate: 'LOCATION', statement: `Wren is at place ${i}.`, objectLiteral: `place q${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}` }));
        expect(detectRuleContradictions(many, clock).pairs).toEqual([]);
        // A position and a stated time in no shared order decide nothing either.
        expect(decidedOverlap({ ownerElementId: 'beat-late', storyTimeFrom: null, storyTimeTo: null }, { storyTimeFrom: 'May', storyTimeTo: null }, clock)).toBeNull();
    });

    it('KNOWLEDGE: opposite polarity about one thing at once, or knowing before not knowing; learning later is not a contradiction', () => {
        const knows = fact({ predicate: 'KNOWLEDGE', statement: 'Wren knows the mill is haunted.' });
        const doesNot = fact({ predicate: 'KNOWLEDGE', statement: 'Wren does not know the mill is haunted.' });
        expect(propositionKey(knows.statement)).toBe(propositionKey(doesNot.statement));
        // D28 addendum: undated, the two are left to the deep check; at one stated time they clash.
        expect(ruleContradiction(knows, doesNot)).toBeNull();
        expect(ruleContradiction({ ...knows, storyTimeFrom: 'the flood night' }, { ...doesNot, storyTimeFrom: 'the flood night' })).toBe('KNOWLEDGE');
        expect(ruleContradiction({ ...knows, ownerElementId: 'beat-late' }, { ...doesNot, ownerElementId: 'beat-late' }, clock)).toBe('KNOWLEDGE');
        const knowsEarly = { ...knows, ownerElementId: 'beat-early' };
        const notLate = { ...doesNot, ownerElementId: 'beat-late' };
        expect(ruleContradiction(knowsEarly, notLate, clock)).toBe('KNOWLEDGE');
        const notEarly = { ...doesNot, ownerElementId: 'beat-early' };
        const knowsLate = { ...knows, ownerElementId: 'beat-late' };
        expect(ruleContradiction(notEarly, knowsLate, clock)).toBeNull();
        // A different thing known is never the same proposition.
        const other = fact({ predicate: 'KNOWLEDGE', statement: 'Wren does not know who forged the deed.' });
        expect(ruleContradiction(knows, other)).toBeNull();
    });

    it('never across subjects, never for a value a thing can hold several of, never with no linked subject', () => {
        const a = fact({ predicate: 'AGE', statement: 'Wren is 12 years old.' });
        const b = fact({ predicate: 'AGE', statement: 'Marrow is 40 years old.', subjectElementId: 'marrow' });
        expect(ruleContradiction(a, b)).toBeNull();
        const r1 = fact({ predicate: 'ROLE', statement: 'Wren is the lock keeper.', objectLiteral: 'lock keeper' });
        const r2 = fact({ predicate: 'ROLE', statement: 'Wren is a smuggler.', objectLiteral: 'smuggler' });
        expect(ruleContradiction(r1, r2)).toBeNull();
        expect(ruleContradiction({ ...a, subjectElementId: null }, { ...a, id: 'x', subjectElementId: null, statement: 'Wren is 13.' })).toBeNull();
    });

    it('detects pairs within each subject only, counting the work, and cuts an oversized subject (counted)', () => {
        const facts = [
            fact({ predicate: 'AGE', statement: 'Wren is 12 years old.' }),
            fact({ predicate: 'AGE', statement: 'Wren is 13 years old.' }),
            fact({ predicate: 'AGE', statement: 'Marrow is 40.', subjectElementId: 'marrow' }),
            fact({ predicate: 'AGE', statement: 'Marrow is 41.', subjectElementId: 'marrow' }),
            fact({ predicate: 'WANT', statement: 'Wren wants to cross.' }),
        ];
        const r = detectRuleContradictions(facts);
        expect(r.pairs.map((p) => p.kind)).toEqual(['VALUE', 'VALUE']);
        // Wren's three facts give three pairs, Marrow's two give one: never the ten of the whole set.
        expect(r.compared).toBe(4);
        expect(r.cut).toBe(0);
        const big = detectRuleContradictions(facts, NO_ORDER, 2);
        expect(big.cut).toBe(1);
    });
});
