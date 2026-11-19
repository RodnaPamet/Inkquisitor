/**
 * Completeness on the book board (Phase 1.2) and rule 6: zero is never
 * complete. No entries is "not started", a template with no fields is "not
 * assessed", and only a real denominator gives a figure.
 */
import { completeness, completenessPercent } from '@/lib/bible/completeness';

describe('completeness', () => {
    it('reads "not started" for a kind with no entries, whatever is claimed filled', () => {
        expect(completeness({ entries: 0, filled: 0, fieldsPerEntry: 14 })).toEqual({ state: 'not-started' });
        expect(completeness({ entries: 0, filled: 5, fieldsPerEntry: 14 })).toEqual({ state: 'not-started' });
    });

    it('reads "not assessed" for a template with no fields, with or without entries', () => {
        expect(completeness({ entries: 3, filled: 0, fieldsPerEntry: 0 })).toEqual({ state: 'not-assessed' });
        expect(completeness({ entries: 0, filled: 0, fieldsPerEntry: 0 })).toEqual({ state: 'not-assessed' });
        expect(completeness({ entries: 2, filled: 0, fieldsPerEntry: Number.NaN })).toEqual({ state: 'not-assessed' });
    });

    it('measures filled fields over template fields times entries', () => {
        expect(completeness({ entries: 2, filled: 7, fieldsPerEntry: 14 })).toEqual({ state: 'measured', filled: 7, total: 28, ratio: 0.25 });
    });

    it('measures a real zero when entries exist and nothing is filled', () => {
        expect(completeness({ entries: 1, filled: 0, fieldsPerEntry: 9 })).toEqual({ state: 'measured', filled: 0, total: 9, ratio: 0 });
    });

    it('never exceeds the total, nor goes below zero', () => {
        expect(completeness({ entries: 1, filled: 40, fieldsPerEntry: 9 })).toMatchObject({ filled: 9, ratio: 1 });
        expect(completeness({ entries: 1, filled: -3, fieldsPerEntry: 9 })).toMatchObject({ filled: 0, ratio: 0 });
    });

    it('rounds down, so only a complete set reads 100%', () => {
        const almost = completeness({ entries: 1, filled: 199, fieldsPerEntry: 200 });
        if (almost.state !== 'measured') throw new Error('expected measured');
        expect(completenessPercent(almost)).toBe(99);
        const full = completeness({ entries: 1, filled: 200, fieldsPerEntry: 200 });
        if (full.state !== 'measured') throw new Error('expected measured');
        expect(completenessPercent(full)).toBe(100);
    });
});
