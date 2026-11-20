/**
 * The irregular-forms table laid over Porter2 (Phase 3.4, decision D21):
 * modest, reviewed, and each entry pulling its weight.
 */
import { IRREGULAR_FORMS, IRREGULAR_SURFACES_BY_STEM, lemmaOf } from '@/lib/search/irregular';
import { createAnalyzer, foldWord, STOP_WORDS } from '@/lib/search/analyse';
import { porter2Stem } from '@/lib/search/porter2';

const a = createAnalyzer('en');

it.each([
    ['went', 'go'],
    ['gone', 'go'],
    ['goes', 'go'],
    ['going', 'go'],
    ['ran', 'run'],
    ['running', 'run'],
    ['mice', 'mouse'],
    ['children', 'child'],
    ['wolves', 'wolf'],
    ['thought', 'think'],
    ['written', 'write'],
])('%s stems as %s does', (form, lemma) => {
    expect(a.stemOf(form)).toBe(a.stemOf(lemma));
});

it('leaves out forms that are as often another word (a search must not find the wrong word)', () => {
    for (const form of ['left', 'saw', 'rose', 'fell', 'lay', 'bore', 'bit', 'lit', 'dove', 'ground', 'bound', 'wound', 'lives', 'leaves', 'does', 'better']) {
        expect([form, IRREGULAR_FORMS.has(form)]).toEqual([form, false]);
    }
});

it('stays modest: a reviewed table, not a dictionary', () => {
    expect(IRREGULAR_FORMS.size).toBeGreaterThan(50);
    expect(IRREGULAR_FORMS.size).toBeLessThanOrEqual(250);
});

describe('every entry', () => {
    const entries = [...IRREGULAR_FORMS];

    it('changes the stem the form would otherwise get', () => {
        expect(entries.filter(([form, lemma]) => porter2Stem(form) === porter2Stem(lemma))).toEqual([]);
    });

    it('names a lemma that is not itself a form (no chains)', () => {
        expect(entries.filter(([, lemma]) => IRREGULAR_FORMS.has(lemma))).toEqual([]);
    });

    it('is keyed by its folded lower-case form, and is no stop word', () => {
        expect(entries.filter(([form]) => foldWord(form) !== form || STOP_WORDS.has(form))).toEqual([]);
        expect(entries.filter(([, lemma]) => foldWord(lemma) !== lemma)).toEqual([]);
    });

    it('is reachable from its lemma’s stem (what a source must contain to hold the form)', () => {
        expect(entries.filter(([form, lemma]) => !(IRREGULAR_SURFACES_BY_STEM.get(porter2Stem(lemma)) ?? []).includes(form))).toEqual([]);
    });
});

it('a form not in the table is its own lemma', () => {
    expect(lemmaOf('lighthouse')).toBe('lighthouse');
});
