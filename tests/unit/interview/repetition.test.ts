/**
 * The book-level repetition reading (Phase 2.H item 3): repeats by element and
 * keyed dedupe key, rephrased originals left out, and NOT_ASSESSED over none.
 */
import { bookRepetition } from '@/lib/interview/repetition';

describe('bookRepetition', () => {
    it('over no question is NOT_ASSESSED, never a 0 % rate (rule 6)', () => {
        expect(bookRepetition([])).toEqual({ status: 'NOT_ASSESSED', asked: 0 });
        expect(bookRepetition([{ elementId: 'e', dedupeKey: 'k', superseded: true }])).toEqual({ status: 'NOT_ASSESSED', asked: 0 });
    });

    it('counts a second question on the same element with the same key; the same key on another element is no repeat', () => {
        expect(
            bookRepetition([
                { elementId: 'e1', dedupeKey: 'k1' },
                { elementId: 'e1', dedupeKey: 'k1' },
                { elementId: 'e2', dedupeKey: 'k1' },
                { elementId: 'e1', dedupeKey: 'k2' },
            ]),
        ).toEqual({ status: 'MEASURED', asked: 4, repeats: 1, rate: 0.25 });
    });

    it('a rephrase and the original it replaced are one question', () => {
        expect(bookRepetition([{ elementId: 'e', dedupeKey: 'k', superseded: true }, { elementId: 'e', dedupeKey: 'k' }])).toMatchObject({ repeats: 0, asked: 1 });
    });
});
