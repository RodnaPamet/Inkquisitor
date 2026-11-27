/**
 * The engine as a whole (Phase 5.2, D34): narration rules never read speech,
 * the bounds name their cuts, the dismissal key is the sentence's, a stored
 * detail is sanitised and bounded, and the work is COUNTED, never timed, and
 * linear in the text (a 10,000-word scene).
 */
import { check } from '../../helpers/prose-checks';
import { parseFindingDetail, sanitiseFindingDetail, DETAIL_STRING_MAX } from '@/lib/prose-checks/storage';
import { normaliseSentence } from '@/lib/prose-checks/segments';
import { PROSE_CHECK_TEXT_MAX_CHARS, PROSE_FINDINGS_PER_RULE_MAX, PROSE_RULES, PROSE_RULE_IDS } from '@/lib/prose-checks/vocabulary';

/** A scene of `paragraphs` paragraphs of mixed narration and speech, deterministic. */
function scene(paragraphs: number): string {
    const p: string[] = [];
    for (let i = 0; i < paragraphs; i++) {
        p.push(`<p>Mara crossed the harbour wall at dusk and felt the wind turn ${i % 3 === 0 ? 'very' : 'slowly'} cold. “We should go back,” she said, and the gulls wheeled over the grey water.</p>`);
    }
    return p.join('');
}

describe('scope', () => {
    it('drops every narration rule’s finding that touches speech, and keeps the ALL rules there', () => {
        const out = check('<p>“She saw it, very clearly, the colour,” he said.</p>', { sheet: { quote_marks: 'double', check_spelling: 'american' }, alex: true });
        const rules = new Set(out.findings.map((f) => f.ruleId));
        for (const r of rules) expect(PROSE_RULES[r].scope === 'ALL' || r === 'spelling-variant').toBe(true);
        expect(rules.has('spelling-variant')).toBe(true);
        expect(rules.has('filter-words')).toBe(false);
        expect(rules.has('intensifiers')).toBe(false);
    });
});

describe('bounds', () => {
    it('cuts a text past the bound at a line break and says so', () => {
        const long = Array.from({ length: 2_500 }, (_, i) => `Line ${i} holds a few plain words for the bound to cut.`).join('\n');
        expect(long.length).toBeGreaterThan(PROSE_CHECK_TEXT_MAX_CHARS);
        const out = check(long);
        expect(out.textCut).toBe(true);
        expect(out.charsChecked).toBeLessThanOrEqual(PROSE_CHECK_TEXT_MAX_CHARS);
    });
    it('keeps at most the per-rule bound of a rule, the first by position, and names the cut', () => {
        const many = Array.from({ length: PROSE_FINDINGS_PER_RULE_MAX + 10 }, () => 'He was very tired.').join(' ');
        const out = check(many);
        const kept = out.findings.filter((f) => f.ruleId === 'intensifiers');
        expect(kept).toHaveLength(PROSE_FINDINGS_PER_RULE_MAX);
        expect(out.findingsCut).toBe(true);
        expect(kept[0].start).toBeLessThan(kept[kept.length - 1].start);
    });
});

describe('the dismissal key', () => {
    it('is the normalised sentence the finding sits in, with its rule', () => {
        const out = check('Nothing here. He was  VERY tired.');
        const f = out.findings.find((x) => x.ruleId === 'intensifiers')!;
        expect(f.sentenceKey).toBe(`intensifiers|${normaliseSentence('He was  VERY tired.')}`);
        expect(normaliseSentence('He was  VERY tired.')).toBe('he was very tired.');
    });
    it('moves when the sentence changes and holds when only another one does', () => {
        const a = check('He was very tired. The sea rose.').findings[0].sentenceKey;
        const b = check('He was very tired. The sea fell.').findings[0].sentenceKey;
        const c = check('He was very weary. The sea rose.').findings[0].sentenceKey;
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });
});

describe('a stored detail', () => {
    it('is sanitised, bounded and read back; anything else reads empty', () => {
        const raw = sanitiseFindingDetail({ params: { word: '<b>x</b>' + 'y'.repeat(500), count: 3, bad_key: 'z', nan: Number.NaN }, suggestion: { start: 1, end: 4, replacement: 'use' } });
        const back = parseFindingDetail(raw);
        expect(back.params.word).not.toContain('<b>');
        expect(String(back.params.word).length).toBeLessThanOrEqual(DETAIL_STRING_MAX);
        expect(back.params).not.toHaveProperty('bad_key');
        expect(back.params).not.toHaveProperty('nan');
        expect(back.suggestion).toEqual({ start: 1, end: 4, replacement: 'use' });
        expect(parseFindingDetail('not json')).toEqual({ params: {}, suggestion: null });
        expect(parseFindingDetail('{"params":{},"suggestion":null,"extra":1}')).toEqual({ params: {}, suggestion: null });
    });
});

describe('counted work (no clock)', () => {
    it('is linear in the text: a 10,000-word scene does at most a fixed multiple of its words', () => {
        const small = check(scene(20), { sheet: { check_tense: 'past', check_person: 'third_limited', check_spelling: 'american', quote_marks: 'double', avoided_words: ['grey'] }, alex: true, characters: [{ id: 'm', name: 'Mara' }] });
        const big = check(scene(360), { sheet: { check_tense: 'past', check_person: 'third_limited', check_spelling: 'american', quote_marks: 'double', avoided_words: ['grey'] }, alex: true, characters: [{ id: 'm', name: 'Mara' }] });
        expect(big.wordsChecked).toBeGreaterThanOrEqual(10_000);
        expect(big.textCut).toBe(false);
        // Every word visited a bounded number of times by every rule, whatever the scene's length.
        const perWord = (o: typeof big) => o.work.ops / o.work.words;
        expect(perWord(big)).toBeLessThanOrEqual(PROSE_RULE_IDS.length * 2);
        expect(perWord(big)).toBeLessThanOrEqual(perWord(small) * 1.1);
        expect(big.work.sentences).toBeLessThanOrEqual(big.work.words);
        // Stems are cached per word form: the vocabulary, not the text, bounds them.
        expect(big.work.stems).toBeLessThan(200);
    });
});
