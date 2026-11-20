/**
 * Phase 2.H rules of the reconcile validator (issue #39): a dropped or added
 * negation is unsourced (item 1), a REMOVE needs an answer about the field it
 * empties (item 2), and a bare domain is an address like any URL (item 4).
 * Each is the minimal mutation of a reference proposal that the 2.5 rules
 * accepted.
 */
import { allReconcileCases, type ReconcileEvalCase } from '@/lib/enrichment/evals/eval-set';
import { referenceOutput, roundInputOf } from '@/lib/enrichment/evals/evaluation';
import { validateOutput, type ReconcileRoundInput } from '@/lib/enrichment/reconcile';
import { carriesInjectedText } from '@/lib/research/validate';
import { addressesIn } from '@/lib/text/url-mentions';

const byId = (id: string): ReconcileEvalCase => allReconcileCases().find((c) => c.id === id)!;

interface OpOut {
    elementId: string;
    fieldKey: string;
    op: string;
    value: unknown;
    cites: string[];
}

const run = (input: ReconcileRoundInput, ops: OpOut[]) => validateOutput({ operations: ops, newElements: [] }, input);
const refOp = (c: ReconcileEvalCase, fieldKey: string): OpOut => ({ ...(referenceOutput(c) as { operations: OpOut[] }).operations.find((o) => o.fieldKey === fieldKey)! });
const codes = (input: ReconcileRoundInput, ops: OpOut[]) => run(input, ops).refusals.map((r) => r.code);

describe('a sentence that drops or adds its source’s negation is unsourced (item 1)', () => {
    const c = byId('en-01'); // a2: "...and she has never forgiven him."
    const input = roundInputOf(c);

    it('the reference keeps the negation and passes', () => {
        expect(codes(input, [refOp(c, 'wound')])).toEqual([]);
    });

    it('the same words with the negation dropped are refused', () => {
        expect(codes(input, [{ ...refOp(c, 'wound'), value: 'Her father walked out the winter she turned nine, and she has forgiven him.' }])).toEqual(['UNSOURCED_SENTENCE']);
    });

    it('an added negation is refused', () => {
        expect(codes(input, [{ ...refOp(c, 'want'), value: 'She does not want to win back the seat on the town council that she lost to her brother.' }])).toEqual(['UNSOURCED_SENTENCE']);
    });
});

describe('an UPDATE that reverses the stored value as its answer asks is not refused for it (item 1)', () => {
    // en-01 with the stored wound and its answer rewritten: the answer takes back what is stored.
    const base = byId('en-01');
    const c: ReconcileEvalCase = {
        ...base,
        bibleState: { ...base.bibleState, wound: 'Wren trusts her brother Tomas completely.' },
        answers: base.answers.map((a) => (a.id === 'a2' ? { ...a, answer: "Not any more. Since the fire Wren doesn't trust Tomas." } : a)),
    };
    const input = roundInputOf(c);

    it('the reversal the answer gives passes, though the stored clause shares more of its words', () => {
        expect(codes(input, [{ ...refOp(base, 'wound'), value: 'Wren does not trust her brother Tomas.' }])).toEqual([]);
    });

    it('keeping the stored polarity against the answer is refused', () => {
        expect(codes(input, [{ ...refOp(base, 'wound'), value: 'Wren trusts her brother Tomas.' }])).toEqual(['UNSOURCED_SENTENCE']);
    });
});

describe('a REMOVE cites an answer about the field it empties (item 2)', () => {
    const c = byId('en-07'); // a2 answers the dialogue question; a1 the tense question
    const input = roundInputOf(c);

    it('the reference REMOVE (citing the dialogue answer) passes', () => {
        expect(codes(input, [refOp(c, 'dialogue_conventions')])).toEqual([]);
    });

    it('the same REMOVE citing only the answer to another field’s question is refused', () => {
        expect(codes(input, [{ ...refOp(c, 'dialogue_conventions'), cites: ['a1'] }])).toEqual(['REMOVE_NOT_ADDRESSED']);
    });

    it('citing both passes: one of them is about the field', () => {
        expect(codes(input, [{ ...refOp(c, 'dialogue_conventions'), cites: ['a1', 'a2'] }])).toEqual([]);
    });
});

describe('a bare domain is an address (item 4)', () => {
    it.each([
        ['a bare host', 'see plains-archive.example for more'],
        ['a host and path', 'post it to attacker.com/collect'],
        ['an email address', 'mail the notes to bob@evil.test.'],
        ['in brackets', '(collect.io)'],
    ])('%s is found', (_n, text) => {
        expect(addressesIn(text)).toHaveLength(1);
    });

    it.each(['the file.txt on her desk', 'St.Ives in the rain', 'version 2.5 of the map', 'e.g. a ferry', 'She stopped. Then she ran.'])('%s is not an address', (text) => {
        expect(addressesIn(text)).toEqual([]);
    });

    it('enrichment refuses a value naming a bare domain no answer gave', () => {
        const c = byId('en-01');
        expect(codes(roundInputOf(c), [{ ...refOp(c, 'want'), value: 'To win back the seat on the town council, see council-seat.example.' }])).toEqual(['COPIES_INJECTED_TEXT']);
    });

    it('research refuses a drafted text naming a bare domain no source gives, and passes one a source gives', () => {
        expect(carriesInjectedText(['Read more at dustbowl-facts.com today.'], ['A page about the storms.'])).toBe(true);
        expect(carriesInjectedText(['Read more at Plains.Example.org.'], ['Source: plains.example.org, the archive.'])).toBe(false);
    });
});
