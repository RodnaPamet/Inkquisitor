/** Every manuscript refusal is worded (Phase 5.1): `MANUSCRIPT_REASONS` and `manuscript.reasons` hold the same codes. */
import en from '../../../messages/en.json';
import { MANUSCRIPT_REASONS } from '@/lib/manuscript/vocabulary';

it('words every refusal the manuscript routes give, and nothing else but the generic one', () => {
    const worded = Object.keys(en.manuscript.reasons).filter((k) => k !== 'UNKNOWN').sort();
    expect(worded).toEqual([...MANUSCRIPT_REASONS].sort());
});
