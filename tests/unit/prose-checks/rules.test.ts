/**
 * Every prose-check rule (Phase 5.2, D34) on what it must flag and on the NEAR
 * MISS it must not: precision matters more than recall (5.H samples 500
 * findings and retunes any rule under 70 % useful), so each rule is held to
 * the quiet cases a broader one would get wrong.
 */
import { check, hits } from '../../helpers/prose-checks';
import { buildBaseline } from '@/lib/prose-checks/baseline';
import { inCaseOf, variantFor } from '@/lib/prose-checks/spelling-variants';

describe('filter words (original)', () => {
    it('flags a perceiving verb right after a subject, with one bridging word', () => {
        const out = check('She saw the door open. He could hear the rain. Mara felt the cold.', { characters: [{ id: 'm', name: 'Mara Quill' }] });
        expect(hits(out, 'filter-words')).toEqual(['saw', 'hear', 'felt']);
    });
    it('stays quiet without a subject, in speech, and as a tag after speech or thought', () => {
        const out = check('<p>The saw lay on the bench. A feel for it came slowly.</p><p>“I saw him,” she said.</p><p><em>Not again</em>, she thought.</p>', { sheet: { quote_marks: 'double' } });
        expect(hits(out, 'filter-words')).toEqual([]);
    });
    it('does not take a lower-case word for a character’s name', () => {
        expect(hits(check('The hope felt real.', { characters: [{ id: 'h', name: 'Hope' }] }), 'filter-words')).toEqual([]);
        expect(hits(check('Hope felt real.', { characters: [{ id: 'h', name: 'Hope' }] }), 'filter-words')).toEqual(['felt']);
    });
});

describe('overused words against the book’s own baseline (original)', () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `Word${i % 7} moves along the quiet harbour wall.`).join(' ');
    const scene = `${filler(60)} She glanced up. He glanced back. They glanced away. Everyone glanced at the clock. Then she glanced again.`;
    // The book: this scene and nine like it without the word (so the filler is the book's ordinary rate).
    const book = (other: string) => buildBaseline([scene, ...Array.from({ length: 9 }, () => other)]);
    it('flags a word used far more often here than in the book, once, at its first use', () => {
        const out = check(scene, { baseline: book(filler(62)) });
        expect(hits(out, 'overused-words')).toEqual(['glanced']);
        expect(out.findings.find((f) => f.ruleId === 'overused-words')?.params).toMatchObject({ word: 'glanced', count: 5 });
    });
    it('stays quiet when the book uses the word as often, with no baseline, or with too small a book', () => {
        expect(hits(check(scene, { baseline: book(scene) }), 'overused-words')).toEqual([]);
        expect(hits(check(scene, { baseline: null }), 'overused-words')).toEqual([]);
        expect(hits(check(scene, { baseline: buildBaseline([scene]) }), 'overused-words')).toEqual([]);
    });
    it('assumes a word past the kept list is as common as the least kept one (fewer notes, never more)', () => {
        const kept = book(filler(62));
        expect(hits(check(scene, { baseline: { ...kept, counts: Object.fromEntries(Object.entries(kept.counts).filter(([k]) => k !== 'glanc')), minKept: 400 } }), 'overused-words')).toEqual([]);
    });
});

describe('repeated openers (original)', () => {
    it('flags the third narration sentence in a row opening with the same word, once a run', () => {
        const out = check('She ran. She stopped. She turned. She waited. Then the bell rang.');
        expect(hits(out, 'repeated-openers')).toEqual(['She']);
        expect(out.findings.filter((f) => f.ruleId === 'repeated-openers')).toHaveLength(1);
    });
    it('stays quiet at two in a row and when speech breaks the run', () => {
        expect(hits(check('She ran. She stopped. Then she turned.'), 'repeated-openers')).toEqual([]);
        expect(hits(check('<p>She ran. She stopped. “She’s gone,” he said. She turned.</p>', { sheet: { quote_marks: 'double' } }), 'repeated-openers')).toEqual([]);
    });
});

describe('similar character names (original)', () => {
    const cast = [
        { id: 'a', name: 'Mara Lee' },
        { id: 'b', name: 'Maya' },
        { id: 'c', name: 'Tobias' },
    ];
    it('flags two alike names both named in the scene, at the later one', () => {
        const out = check('Mara crossed the yard. Tobias waited. Maya called after her.', { characters: cast });
        expect(hits(out, 'similar-names')).toEqual(['Maya']);
    });
    it('stays quiet when only one of the pair appears, or the pair is not alike', () => {
        expect(hits(check('Mara crossed the yard. Tobias waited.', { characters: cast }), 'similar-names')).toEqual([]);
        expect(hits(check('Mara met Tobias.', { characters: [{ id: 'a', name: 'Mara' }, { id: 'c', name: 'Tobias' }] }), 'similar-names')).toEqual([]);
    });
});

describe('tense slips (original)', () => {
    it('flags a present verb after a subject in past narration, and a past verb in present narration', () => {
        expect(hits(check('She walked to the door. He walks away.', { sheet: { check_tense: 'past' } }), 'tense-slip')).toEqual(['walks']);
        expect(hits(check('She walks to the door. He said nothing.', { sheet: { check_tense: 'present' } }), 'tense-slip')).toEqual(['said']);
        expect(hits(check("They're late.", { sheet: { check_tense: 'past' } }), 'tense-slip')).toEqual(["They're"]);
    });
    it('stays quiet after a modal, in speech, in italics, with no sheet tense, and on an unlisted verb', () => {
        const sheet = { check_tense: 'past', quote_marks: 'double' };
        expect(hits(check('<p>She could see the shore.</p><p>“He walks,” she said.</p><p><em>She is here</em>, he thought.</p>', { sheet }), 'tense-slip')).toEqual([]);
        expect(hits(check('He walks away.'), 'tense-slip')).toEqual([]);
        expect(hits(check('She saunters off.', { sheet: { check_tense: 'past' } }), 'tense-slip')).toEqual([]);
    });
});

describe('person slips (original)', () => {
    it('flags a first-person word in third-person narration', () => {
        expect(hits(check('She left. I watched her go.', { sheet: { check_person: 'third_limited' } }), 'person-slip')).toEqual(['I']);
    });
    it('stays quiet in speech, italics, a numeral, and for a first-person sheet', () => {
        const sheet = { check_person: 'third_omniscient', quote_marks: 'double' };
        expect(hits(check('<p>“I know,” she said. <em>My fault</em>, he thought. The reign of Henry I ended.</p>', { sheet }), 'person-slip')).toEqual([]);
        expect(hits(check('I watched her go.', { sheet: { check_person: 'first' } }), 'person-slip')).toEqual([]);
    });
});

describe('the style sheet’s words (original)', () => {
    it('flags an avoided word or phrase anywhere, and offers a swap in the word’s case', () => {
        const out = check('Suddenly the door opened. He would utilise it. Utilise nothing.', { sheet: { avoided_words: ['suddenly', 'used to begin sentences that ramble on'], word_swaps: ['utilise → use'] } });
        expect(hits(out, 'banned-words')).toEqual(['Suddenly', 'utilise', 'Utilise']);
        expect(out.findings.filter((f) => f.ruleId === 'banned-words').map((f) => f.suggestion?.replacement ?? null)).toEqual([null, 'use', 'Use']);
    });
    it('matches whole words in sequence, never a word inside another', () => {
        expect(hits(check('A suddenness took them.', { sheet: { avoided_words: ['suddenly'] } }), 'banned-words')).toEqual([]);
        expect(hits(check('The dark and the night.', { sheet: { avoided_words: ['dark night'] } }), 'banned-words')).toEqual([]);
    });
});

describe('spelling variants (original list)', () => {
    it('flags the other variety’s spelling and offers the sheet’s, case kept', () => {
        const out = check('The Colour of the theatre was grey.', { sheet: { check_spelling: 'american' } });
        expect(hits(out, 'spelling-variant')).toEqual(['Colour', 'theatre', 'grey']);
        expect(out.findings.map((f) => f.suggestion?.replacement)).toEqual(['Color', 'theater', 'gray']);
    });
    it('leaves alone what the sheet’s variety writes, an ambiguous word, and a Canadian "both"', () => {
        expect(hits(check('The colour of the theatre.', { sheet: { check_spelling: 'british' } }), 'spelling-variant')).toEqual([]);
        expect(hits(check('The meter ran.', { sheet: { check_spelling: 'british' } }), 'spelling-variant')).toEqual([]);
        expect(variantFor('gray', 'canadian')).toBeNull();
        expect(variantFor('color', 'canadian')).toEqual({ preferred: 'colour' });
        expect(variantFor('analyze', 'canadian')).toBeNull();
    });
    it('keeps a word’s case pattern', () => {
        expect([inCaseOf('COLOUR', 'color'), inCaseOf('Colour', 'color'), inCaseOf('colour', 'color')]).toEqual(['COLOR', 'Color', 'color']);
    });
});

describe('the comma before a speech tag (original)', () => {
    it('flags the comma on the wrong side of the closing mark', () => {
        expect(hits(check('<p>“Yes”, she said.</p>', { sheet: { quote_marks: 'double', tag_punctuation: 'inside' } }), 'dialogue-tag-punctuation')).toEqual(['”,']);
        expect(hits(check('<p>“Yes,” she said.</p>', { sheet: { quote_marks: 'double', tag_punctuation: 'outside' } }), 'dialogue-tag-punctuation')).toEqual([',”']);
    });
    it('stays quiet when it is right, before a capital (no tag), and with no marks set', () => {
        expect(hits(check('<p>“Yes,” she said.</p>', { sheet: { quote_marks: 'double', tag_punctuation: 'inside' } }), 'dialogue-tag-punctuation')).toEqual([]);
        expect(hits(check('<p>“Yes”, Then nothing.</p>', { sheet: { quote_marks: 'double', tag_punctuation: 'inside' } }), 'dialogue-tag-punctuation')).toEqual([]);
        expect(hits(check('<p>“Yes”, she said.</p>', { sheet: { tag_punctuation: 'inside' } }), 'dialogue-tag-punctuation')).toEqual([]);
    });
});

describe('write-good’s checks, narrowed for fiction', () => {
    it('flags an intensifier and offers its deletion, re-capitalising a sentence it opened', () => {
        const out = check('He was very tired. Extremely tired, he slept.');
        expect(hits(out, 'intensifiers')).toEqual(['very', 'Extremely']);
        const [a, b] = out.findings.filter((f) => f.ruleId === 'intensifiers');
        expect(out.text.slice(a.suggestion!.start, a.suggestion!.end)).toBe('very ');
        expect(a.suggestion!.replacement).toBe('');
        expect(out.text.slice(b.suggestion!.start, b.suggestion!.end)).toBe('Extremely t');
        expect(b.suggestion!.replacement).toBe('T');
    });
    it('keeps only the intensifiers of its weasel words ("many", "few" are not)', () => {
        expect(hits(check('Many came. Few stayed.'), 'intensifiers')).toEqual([]);
    });
    it('flags a multi-word wordy phrase, never its single words or "It was"', () => {
        const out = check('In order to win, he ran. However, it was late. It was dark.');
        expect(hits(out, 'wordy')).toEqual(['In order to']);
    });
    it('flags a cliché in narration and not in speech', () => {
        const out = check('<p>It was a dark and stormy night.</p><p>“A dark and stormy night,” he said.</p>', { sheet: { quote_marks: 'double' } });
        expect(hits(out, 'cliches')).toEqual(['a dark and stormy night']);
    });
});

describe('retext’s repeated words', () => {
    it('flags the repeat and offers the deletion of it', () => {
        const out = check('The the door opened.');
        expect(hits(out, 'repeated-words')).toEqual(['the']);
        const f = out.findings.find((x) => x.ruleId === 'repeated-words')!;
        expect(out.text.slice(f.suggestion!.start, f.suggestion!.end)).toBe(' the');
    });
    it('stays quiet across a sentence break', () => {
        expect(hits(check('He said that. That was all.'), 'repeated-words')).toEqual([]);
    });
});

describe('alex’s rules (the inclusive-language check)', () => {
    it('is off unless the book turns it on', () => {
        expect(hits(check('The chairman spoke.'), 'inclusive-language')).toEqual([]);
        expect(hits(check('The chairman spoke.', { alex: true }), 'inclusive-language')).toEqual(['chairman']);
    });
    it('never reads speech, and never flags a personal pronoun', () => {
        const out = check('<p>“The chairman is late,” she said. He waited for her.</p>', { alex: true, sheet: { quote_marks: 'double' } });
        expect(hits(out, 'inclusive-language')).toEqual([]);
    });
});

describe('readability per scene (original syllable count, published formulas)', () => {
    it('reports a number and a band for a scene long enough, and nothing below the floor', () => {
        const long = Array.from({ length: 30 }, () => 'The cat sat on the mat by the door.').join(' ');
        const r = check(long).readability!;
        expect(r.words).toBe(270);
        expect(r.readingEase).toBeGreaterThan(90);
        expect(r.band).toBe('very_easy');
        expect(check('Too short to say.').readability).toBeNull();
    });
});
