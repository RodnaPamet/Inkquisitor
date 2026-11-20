/**
 * Grounding keeps its source's polarity (issue #39 item 1): "not" is a stop
 * word, so a dropped or added negation grounded lexically. Both validators
 * (enrichment's and research's) refuse such a sentence as unsourced.
 */
import { clauses, negated, polarityKept } from '@/lib/text/negation';

describe('negated', () => {
    it.each(['She does not trust him.', "She doesn't trust him.", 'She never trusts him.', 'No one trusts him.', 'Nobody trusts him.', 'She can’t trust him.'])('%s', (s) => expect(negated(s)).toBe(true));
    it.each(['She trusts him.', 'Nothing-shaped fears.'.replace('Nothing-shaped', 'Notable'), 'Knots and nooks.'])('%s is not', (s) => expect(negated(s)).toBe(false));
});

describe('polarityKept', () => {
    it('refuses a dropped negation (the issue’s example), and an added one', () => {
        expect(polarityKept('She trusts him.', ['She does not trust him.'])).toBe(false);
        expect(polarityKept('Ilse does not keep the lighthouse.', ['Ilse keeps the lighthouse alone after her brother drowns.'])).toBe(false);
    });

    it('passes the same polarity, either way', () => {
        expect(polarityKept('She does not trust him.', ['She does not trust him at all.'])).toBe(true);
        expect(polarityKept('She trusts him completely.', ['She trusts him.'])).toBe(true);
    });

    it('reads each clause of a mixed source on its own (contrastive negation)', () => {
        expect(polarityKept('She trusts his sister.', ['She does not trust him, but she trusts his sister.'])).toBe(true);
        expect(polarityKept('October 1961.', ['It was the autumn, not the spring: October 1961.'])).toBe(true);
        expect(polarityKept('It appears only in the three kitchen chapters.', ['it now turns up only in the three kitchen chapters, not at the wedding.'])).toBe(true);
        expect(polarityKept('Custom.', ["it's no longer a law but a custom, and it applies only on feast nights, not every night."])).toBe(true);
    });

    it('leaves a clause sharing no content word with the sources to grounding', () => {
        expect(polarityKept('Entirely unrelated words.', ['She does not trust him.'])).toBe(true);
    });

    it('splits clauses at punctuation and contrasting conjunctions', () => {
        expect(clauses('One; two: three, four but five. Six')).toEqual(['One', 'two', 'three', 'four', 'five.', 'Six']);
    });
});

it('reads a negation as covering only the words after it in its clause', () => {
    expect(polarityKept('The dust turned day into darkness.', ['The dust turned day into darkness and people could not see their own hands.'])).toBe(true);
    expect(polarityKept('People could see their own hands.', ['The dust turned day into darkness and people could not see their own hands.'])).toBe(false);
});
