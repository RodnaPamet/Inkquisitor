/**
 * Deduplication (design 7) and the text it stands on (design 4.5): the
 * normalisation, the grounding test, and the duplicate rule on paraphrase
 * pairs (which must match) and near-miss pairs on one field (which must not),
 * drawn from the craft packs' own example questions.
 */
import { getPacks } from '@/lib/interview/packs';
import {
    DEDUPE,
    dedupe,
    dedupeTokens,
    duplicateSignal,
    exactKey,
    jaccard,
    questionDedupeKey,
    trigramDice,
    type AskedQuestion,
    type DedupeQuestion,
} from '@/lib/interview/dedupe';
import { GROUNDING_THRESHOLD, contentTokens, groundSentence, grounded, normaliseText, sentences, stem } from '@/lib/interview/text';
import { isCatchAllOption } from '@/lib/interview/candidates';

const EL = 'el-1';
const ctx = { elementNames: new Map([[EL, 'Dov Hartigan']]) };
const q = (text: string, targets: string[] = ['want'], over: Partial<DedupeQuestion> = {}): DedupeQuestion => ({
    elementId: EL,
    targetsFieldKeys: targets,
    kind: 'OPEN',
    text,
    options: null,
    scaleLabels: null,
    ...over,
});
const asked = (id: string, d: DedupeQuestion, scope: 'SESSION' | 'BOOK' = 'SESSION'): AskedQuestion => ({ ...d, id, scope });

describe('normalisation and tokens', () => {
    it('folds case, width, zero-width characters and look-alike letters', () => {
        expect(normaliseText('ＷＨＡＴ​ dоes  Dov⁠ want?')).toBe('what does dov want?');
        expect(contentTokens('What does Dov want, wanting it?')).toEqual(['dov', 'want', 'want']);
        expect(['stories', 'boxes', 'wanted', 'running', 'quickly', 'grass'].map(stem)).toEqual(['story', 'box', 'want', 'runn', 'quick', 'grass']);
    });

    it('drops every invisible character, the astral TAG characters and variation selectors included', () => {
        // Tag characters spell hidden text; a variation selector or a filler renders as nothing.
        expect(normaliseText('Wh\u{E0061}at does Dov\u{E0020} want\u{E007F}?')).toBe('what does dov want?');
        expect(normaliseText('Oth\u{E0065}er\u{E0100}\uFE0F\u3164')).toBe('other');
        expect(isCatchAllOption('O\u{E0074}ther')).toBe(true);
        expect(dedupeTokens(q('What does D\u{E0041}ov want?'), ctx)).toEqual(dedupeTokens(q('What does Dov want?'), ctx));
    });

    it('drops the element’s name and role phrases, so how a question addresses it does not matter', () => {
        expect(dedupeTokens(q('What does Dov Hartigan want?'), ctx)).toEqual(dedupeTokens(q('What does your protagonist want?'), ctx));
    });

    it('the dedupe key is keyed, stable and tells two texts apart', () => {
        const a = questionDedupeKey(dedupeTokens(q('What does he want most?'), ctx));
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(questionDedupeKey(dedupeTokens(q('Most, what does he want?'), ctx))).toBe(a);
        expect(questionDedupeKey(dedupeTokens(q('What does he fear most?'), ctx))).not.toBe(a);
    });
});

describe('the grounding test (design 4.5)', () => {
    const sources = ['He froze at a roadside crash at nineteen and a stranger died.'];

    it('a sentence built from the sources passes; an added name or an invented clause fails', () => {
        expect(grounded('A stranger died when he froze at a roadside crash.', sources)).toBe(true);
        expect(groundSentence('A stranger named Elsa died when he froze.', sources).unsupportedNames).toEqual(['Elsa']);
        expect(grounded('He froze at the crash. He then fled to the mountains with his sister.', sources)).toBe(false);
        expect(GROUNDING_THRESHOLD).toBe(0.7);
    });

    it('sees through look-alike letters and zero-width characters in the sources', () => {
        expect(grounded('A stranger died at the crash.', ['A strаnger​ died at the сrash.'])).toBe(true);
    });

    it('nothing to ground is never grounded', () => {
        expect(grounded('', sources)).toBe(false);
        expect(sentences('One. Two? Three!\nFour')).toEqual(['One.', 'Two?', 'Three!', 'Four']);
    });
});

describe('the duplicate rule', () => {
    it('paraphrases on the same field match', () => {
        const pairs: Array<[string, string]> = [
            ['What does your protagonist want most?', 'Most of all, what does Dov want?'],
            ['What does this character knowingly go after?', 'What does this character knowingly go after, in their own words?'],
            ['What does Dov want, stated as something he could win or lose?', 'Stated as something he could win or lose, what does he want?'],
        ];
        for (const [a, b] of pairs) expect(duplicateSignal(q(a), q(b), ctx)).not.toBeNull();
    });

    it('near-misses on the same field do not', () => {
        const pairs: Array<[string, string]> = [
            ['What does your protagonist want most?', 'Would your protagonist admit to that want if asked outright?'],
            ['What does this character knowingly go after?', 'What would this character give up to get it?'],
        ];
        for (const [a, b] of pairs) expect(duplicateSignal(q(a), q(b), ctx)).toBeNull();
    });

    it('the craft packs’ own examples for one field are not duplicates of each other', () => {
        const packs = getPacks();
        let compared = 0;
        for (const pack of Object.values(packs.craft)) {
            const ex = pack.examples.filter((e) => e.keys.length === 1);
            for (let i = 0; i < ex.length; i++) {
                for (let j = i + 1; j < ex.length; j++) {
                    if (ex[i].keys[0] !== ex[j].keys[0]) continue;
                    compared++;
                    const a = q(ex[i].text, ex[i].keys, { kind: ex[i].kind, options: ex[i].options, scaleLabels: ex[i].scaleLabels });
                    const b = q(ex[j].text, ex[j].keys, { kind: ex[j].kind, options: ex[j].options, scaleLabels: ex[j].scaleLabels });
                    expect([pack.name, ex[i].text, duplicateSignal(a, b, ctx)]).toEqual([pack.name, ex[i].text, null]);
                }
            }
        }
        expect(compared).toBeGreaterThan(10);
    });

    it('the same picks on the same field are a duplicate whatever the wording (shape)', () => {
        const a = q('Which way does the want point?', ['want'], { kind: 'CHOICE', options: ['rank', 'safety', 'being seen'] });
        const b = q('Where is his aim directed?', ['want'], { kind: 'CHOICE', options: ['Rank', 'safety', 'love'] });
        expect(duplicateSignal(a, b, ctx)).toBe('SHAPE');
    });

    it('a question about ANOTHER element is never a repeat, even word for word', () => {
        expect(duplicateSignal(q('What does this character want?'), { ...q('What does this character want?'), elementId: 'el-2' }, ctx)).toBeNull();
    });

    it('another field of the element needs a near-identical wording, or a near-identical embedding', () => {
        expect(duplicateSignal(q('What does he want, and what does he fear?', ['want']), q('What does he fear, and what does he want?', ['wound']), ctx)).toBe('EXACT');
        expect(duplicateSignal(q('What does he want?', ['want']), q('What wound shaped him?', ['wound']), ctx, 0.95)).toBeNull();
        expect(duplicateSignal(q('What does he want?', ['want']), q('What wound shaped him?', ['wound']), ctx, DEDUPE.OTHER_TARGET_COSINE)).toBe('EMBEDDING');
        expect(duplicateSignal(q('What does he want?'), q('Where is his aim directed?'), ctx, DEDUPE.SAME_TARGET_COSINE)).toBe('EMBEDDING');
    });

    it('the measures behave at their ends', () => {
        expect(jaccard([], [])).toBe(1);
        expect(jaccard(['a'], ['b'])).toBe(0);
        expect(trigramDice('abc', 'abc')).toBe(1);
        expect(trigramDice('abc', 'xyz')).toBeLessThan(0.3);
    });
});

describe('dedupe over a round', () => {
    it('drops repeats of the session and the book, and of an earlier candidate; the first in order wins', () => {
        const candidates = [q('What does he want most?'), q('Most, what does he want?'), q('What wound shaped him?', ['wound']), q('What does he need?', ['need'])];
        const result = dedupe({
            candidates,
            asked: [asked('b1', q('What wound shaped him?', ['wound']), 'BOOK')],
            ctx,
        });
        expect(result.keptIndexes).toEqual([0, 3]);
        expect(result.dropped).toEqual([
            { index: 1, duplicateOf: 'candidate:0', signal: 'EXACT', scope: 'ROUND' },
            { index: 2, duplicateOf: 'b1', signal: 'EXACT', scope: 'BOOK' },
        ]);
    });

    it('uses the store’s neighbours: a score on an asked question, and a neighbour beyond the read', () => {
        const candidates = [q('Where is his aim directed?'), q('What fear drives him?', ['wound'])];
        const result = dedupe({
            candidates,
            asked: [asked('s1', q('What does he want most?'))],
            ctx,
            neighbours: new Map([
                [0, [{ questionId: 's1', score: 0.95 }]],
                [1, [{ questionId: 'far', score: 0.99 }]],
            ]),
            neighbourTargets: new Map([['far', { elementId: EL, targetsFieldKeys: ['wound'] }]]),
        });
        expect(result.keptIndexes).toEqual([]);
        expect(result.dropped.map((d) => d.signal)).toEqual(['EMBEDDING', 'EMBEDDING']);
    });

    it('a neighbour about another element is ignored, and a low score drops nothing', () => {
        const result = dedupe({
            candidates: [q('Where is his aim directed?')],
            asked: [],
            ctx,
            neighbours: new Map([[0, [{ questionId: 'x', score: 0.99 }, { questionId: 'y', score: 0.5 }]]]),
            neighbourTargets: new Map([
                ['x', { elementId: 'el-2', targetsFieldKeys: ['want'] }],
                ['y', { elementId: EL, targetsFieldKeys: ['want'] }],
            ]),
        });
        expect(result.keptIndexes).toEqual([0]);
    });

    it('an exact repeat the index holds beyond the read is dropped', () => {
        const c = q('What does he want most?');
        const key = exactKey(EL, questionDedupeKey(dedupeTokens(c, ctx)));
        expect(dedupe({ candidates: [c], asked: [], ctx, askedKeys: new Set([key]) }).dropped).toEqual([{ index: 0, duplicateOf: 'dedupe-key', signal: 'EXACT', scope: 'BOOK' }]);
    });

    it('candidates in one round compare by their own embeddings', () => {
        const result = dedupe({
            candidates: [q('Where is his aim directed?'), q('What does he want most?')],
            asked: [],
            ctx,
            vectors: new Map([
                [0, [1, 0]],
                [1, [1, 0.01]],
            ]),
        });
        expect(result.keptIndexes).toEqual([0]);
        expect(result.dropped[0]).toMatchObject({ signal: 'EMBEDDING', scope: 'ROUND' });
    });
});
