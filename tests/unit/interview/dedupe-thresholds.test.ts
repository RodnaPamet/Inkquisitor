/**
 * Deduplication's cosine thresholds are per embedding revision and
 * configurable (issue #32, item 1): the operator's entry, a reviewed row, or
 * the uncalibrated default, in that order; and the thresholds handed in are
 * the ones `dedupe` judges by.
 */
import { DEFAULT_COSINE_THRESHOLDS, dedupe, duplicateSignal, type AskedQuestion } from '@/lib/interview/dedupe';
import { CALIBRATED_COSINE_THRESHOLDS, cosineThresholdsConfigProblems, cosineThresholdsFor, DEDUPE_COSINE_THRESHOLDS_PATTERN, parseCosineThresholds } from '@/lib/interview/dedupe-thresholds';
import { productionConfigProblems } from '@/lib/startup-checks';

const ctx = { elementNames: new Map([['e', 'Mara']]) };
const q = (id: string, text: string, key = 'want'): AskedQuestion => ({ id, scope: 'SESSION', elementId: 'e', targetsFieldKeys: [key], kind: 'OPEN', text, options: null, scaleLabels: null });

describe('the thresholds of a revision', () => {
    it('an uncalibrated revision reads the default and says so (the table is empty until the production model is chosen)', () => {
        expect(CALIBRATED_COSINE_THRESHOLDS).toEqual({});
        expect(cosineThresholdsFor('stub:d64', undefined)).toEqual({ ...DEFAULT_COSINE_THRESHOLDS, source: 'UNCALIBRATED_DEFAULT' });
    });

    it('the operator’s entry for THIS revision wins; an entry for another revision does not apply', () => {
        const env = 'tei:bge-small:d384=0.83,0.95;stub:d64=0.99,1';
        expect(cosineThresholdsFor('tei:bge-small:d384', env)).toEqual({ sameTarget: 0.83, otherTarget: 0.95, source: 'ENV' });
        expect(cosineThresholdsFor('tei:other:d768', env).source).toBe('UNCALIBRATED_DEFAULT');
    });

    it('refuses a malformed entry, a threshold at or below 0.5, and a same-target bar above the other', () => {
        for (const bad of ['rev', 'rev=0.9', 'rev=0.9,0.97,1', 'rev=1.2,1', 'rev=0.4,0.9', 'rev=0.98,0.9']) {
            expect(() => parseCosineThresholds(bad)).toThrow(/DEDUPE_COSINE_THRESHOLDS/);
        }
        expect(DEDUPE_COSINE_THRESHOLDS_PATTERN.test('a=0.9,0.97;b=0.8,0.9')).toBe(true);
        expect(DEDUPE_COSINE_THRESHOLDS_PATTERN.test('a=0.9;b')).toBe(false);
    });
});

describe('production refuses at start what the parse would refuse in every round', () => {
    it('a value the env grammar admits but the parse refuses (a bar of 0, a same-target bar above the other) is a start-up problem', () => {
        for (const bad of ['rev=0,0.9', 'rev=0.98,0.9', 'rev=0.9,0.97;b=0.4,0.9']) {
            expect(DEDUPE_COSINE_THRESHOLDS_PATTERN.test(bad)).toBe(true);
            expect(productionConfigProblems({ NODE_ENV: 'production', DEDUPE_COSINE_THRESHOLDS: bad }).some((p) => p.startsWith('DEDUPE_COSINE_THRESHOLDS'))).toBe(true);
        }
        expect(cosineThresholdsConfigProblems('a=0.9,0.97;b=0.8,0.9')).toEqual([]);
        expect(cosineThresholdsConfigProblems(undefined)).toEqual([]);
    });
});

describe('dedupe judges by the thresholds it is handed', () => {
    const asked = q('q1', 'What does she want more than anything?');
    const candidate = q('c1', 'Which aim pulls her through the story?');

    it('a cosine of 0.86 is no repeat under the default, and a repeat under a revision calibrated at 0.85', () => {
        expect(duplicateSignal(candidate, asked, ctx, 0.86)).toBeNull();
        expect(duplicateSignal(candidate, asked, ctx, 0.86, { sameTarget: 0.85, otherTarget: 0.95 })).toBe('EMBEDDING');
    });

    it('through `dedupe`, a neighbour’s score is weighed against the handed thresholds', () => {
        const neighbours = new Map([[0, [{ questionId: 'q1', score: 0.86 }]]]);
        expect(dedupe({ candidates: [candidate], asked: [asked], ctx, neighbours }).keptIndexes).toEqual([0]);
        expect(dedupe({ candidates: [candidate], asked: [asked], ctx, neighbours, cosine: { sameTarget: 0.85, otherTarget: 0.95 } }).dropped).toMatchObject([{ signal: 'EMBEDDING' }]);
    });
});
