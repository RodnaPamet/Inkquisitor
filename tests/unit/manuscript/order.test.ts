/**
 * The manuscript's rebalance (Phase 5.1 review): the first pass's temporary ranks are valid ranks, distinct, and clear
 * of every rank the parent holds or is about to take, so no row lands on a rank another row still holds.
 */
import { isRank, rebalancedRanks } from '@/lib/bible/story-order';
import { temporaryRanks } from '@/app-layer/usecases/manuscript-common';

describe('temporaryRanks', () => {
    it('gives distinct valid ranks clear of every taken one', () => {
        const fresh = rebalancedRanks(40);
        const taken = new Set(['z0z', 'z1z', 'z3z', ...fresh, 'i', `i${'0'.repeat(62)}1`]);
        const temp = temporaryRanks(40, taken);
        expect(temp).toHaveLength(40);
        expect(new Set(temp).size).toBe(40);
        expect(temp.every(isRank)).toBe(true);
        expect(temp.some((r) => taken.has(r))).toBe(false);
        expect(temp.slice(0, 2)).toEqual(['z2z', 'z4z']);
    });
});
