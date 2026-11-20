/**
 * Word search's normaliser and tokeniser (Phase 3.4, decision D21): what a
 * word becomes, and where it sits in its text.
 */
import { caseKeptForm, countWords, createAnalyzer, foldText, foldWord, isCapitalised } from '@/lib/search/analyse';

const en = createAnalyzer('en');

describe('foldWord: the surface form', () => {
    it.each([
        ['Café', 'cafe'],
        ['naïve', 'naive'],
        ['Zoë', 'zoe'],
        ['Straße', 'strasse'],
        ['Æthelred', 'aethelred'],
        ['Søren', 'soren'],
        ['Łódź', 'lodz'],
        ['ﬁre', 'fire'], // the fi ligature, by NFKC
        ['Ｗｒｅｎ', 'wren'], // full-width letters, by NFKC
        ['soft­hyphen', 'softhyphen'], // a format character dropped
        ["Wren's", 'wren'],
        ['Wren’s', 'wren'], // a curly apostrophe
        ['WRENʼS', 'wren'], // a modifier-letter apostrophe, upper case
        ["authors'", 'authors'],
        ["'tis", 'tis'],
        ["don't", "don't"],
        ['don’t', "don't"],
        ['ΟΔΟΣ', 'οδοσ'], // the Greek final sigma read as sigma
    ])('%s → %s', (word, surface) => {
        expect(foldWord(word)).toBe(surface);
    });

    it('keeps case in the case-kept form, folding everything else', () => {
        expect(caseKeptForm('Zoë’s')).toBe('Zoe');
        expect(caseKeptForm('HOPE')).toBe('HOPE');
    });

    it('tells a capital', () => {
        expect(isCapitalised('Hope')).toBe(true);
        expect(isCapitalised('’Twas')).toBe(true);
        expect(isCapitalised('hope')).toBe(false);
        expect(isCapitalised('1984')).toBe(false);
    });
});

describe('tokenise', () => {
    it('cuts words with the Unicode word rules, keeping their offsets in the text', () => {
        const text = 'Wren’s lamp — the café, 3.5 miles off; well-known.';
        const tokens = en.tokenise(text);
        expect(tokens.map((t) => text.slice(t.start, t.end))).toEqual(['Wren’s', 'lamp', 'the', 'café', '3.5', 'miles', 'off', 'well', 'known']);
        expect(tokens.map((t) => t.surface)).toEqual(['wren', 'lamp', 'the', 'cafe', '3.5', 'miles', 'off', 'well', 'known']);
        expect(tokens.find((t) => t.surface === 'miles')?.stem).toBe('mile');
    });

    it('gives each word a surface and a stem, irregular forms through the table', () => {
        const [went, gone] = en.tokenise('went gone');
        expect([went.surface, went.stem, gone.stem]).toEqual(['went', 'go', 'go']);
    });

    it('keeps the exact case of a capitalised word mid-sentence, and not of a sentence’s first word', () => {
        const tokens = en.tokenise('Hope is a thing. She named the dog Hope. "Hope," he said: Hope.');
        const hopes = tokens.filter((t) => t.surface === 'hope').map((t) => t.exact);
        expect(hopes).toEqual([null, 'Hope', null, null]);
    });

    it('keeps every capital of a name-like source', () => {
        expect(en.tokenise('The House of Hope', 'name').map((t) => t.exact)).toEqual(['The', 'House', null, 'Hope']);
    });

    it('caches its stems: words met again cost nothing more', () => {
        const a = createAnalyzer('en');
        a.tokenise('running running runs ran');
        const computed = a.stemsComputed;
        a.tokenise('running runs ran running');
        expect(a.stemsComputed).toBe(computed);
        expect(a.wordsSegmented).toBe(8);
    });

    it('another language matches surface forms: no stemming', () => {
        const other = createAnalyzer('other');
        expect(other.tokenise('Les chevaux couraient').map((t) => [t.surface, t.stem])).toEqual([
            ['les', 'les'],
            ['chevaux', 'chevaux'],
            ['couraient', 'couraient'],
        ]);
    });
});

describe('foldText', () => {
    it('folds a whole text so every word’s surface form is in it', () => {
        const text = 'Zoë’s ﬁre at the Café — ΟΔΟΣ. Straße, Søren­sen.';
        const folded = foldText(text);
        for (const t of en.tokenise(text)) expect([t.surface, folded.includes(t.surface)]).toEqual([t.surface, true]);
    });
});

it('counts words as letter-or-digit runs', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('The lamp, lit at 9 — and the café.')).toBe(8);
});
