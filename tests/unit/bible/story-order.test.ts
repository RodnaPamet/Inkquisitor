/**
 * A story order's ranks (Phase 3.2, decision D22): `rankBetween` always finds
 * a key strictly between two others, of the stored shape; `placeRank` puts an
 * element between the neighbours the author saw and never on another's rank.
 */
import { FIRST_RANK, ORDER_RANK_MAX, ORDER_RANK_PATTERN, compareRanks, isRank, placeRank, rankBetween, rebalancedRanks, RankExhaustedError } from '@/lib/bible/story-order';

/** A small deterministic generator, so a failure is reproducible. */
function random(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

describe('rankBetween', () => {
    it('starts an empty order in the middle, with room both ways', () => {
        expect(rankBetween(null, null)).toBe(FIRST_RANK);
        expect(compareRanks(rankBetween(null, FIRST_RANK), FIRST_RANK)).toBeLessThan(0);
        expect(compareRanks(rankBetween(FIRST_RANK, null), FIRST_RANK)).toBeGreaterThan(0);
    });

    it.each([
        ['a', 'b'],
        ['a', 'a1'],
        ['1', '2'],
        ['0z', '1'],
        ['z', null],
        [null, '1'],
        [null, '01'],
        [null, '0001'],
        ['zzz', null],
        ['h', 'hi'],
        ['101', '11'],
    ] as const)('between %p and %p is strictly between, of the stored shape', (lower, upper) => {
        const key = rankBetween(lower, upper);
        expect(key).toMatch(ORDER_RANK_PATTERN);
        if (lower !== null) expect(compareRanks(lower, key)).toBeLessThan(0);
        if (upper !== null) expect(compareRanks(key, upper)).toBeLessThan(0);
    });

    it('refuses a gap that is not one and a key that is not a rank', () => {
        expect(() => rankBetween('b', 'a')).toThrow(RangeError);
        expect(() => rankBetween('a', 'a')).toThrow(RangeError);
        expect(() => rankBetween('a0', null)).toThrow(RangeError); // never ends in 0
        expect(() => rankBetween('A', null)).toThrow(RangeError); // lower case only
        expect(isRank('')).toBe(false);
        expect(isRank('x'.repeat(ORDER_RANK_MAX + 1))).toBe(false);
    });

    it('keeps any sequence of random inserts strictly ordered, unique and well formed', () => {
        const next = random(7);
        const order: string[] = [];
        for (let i = 0; i < 2000; i++) {
            const at = Math.floor(next() * (order.length + 1));
            const key = rankBetween(order[at - 1] ?? null, order[at] ?? null);
            order.splice(at, 0, key);
        }
        for (let i = 1; i < order.length; i++) expect(compareRanks(order[i - 1], order[i])).toBeLessThan(0);
        expect(new Set(order).size).toBe(order.length);
        for (const k of order) expect(isRank(k)).toBe(true);
    });

    it('grows slowly when appending at the end or the start, and only at the end of a key when splitting one gap', () => {
        let last = FIRST_RANK;
        for (let i = 0; i < 1000; i++) last = rankBetween(last, null);
        expect(last.length).toBeLessThanOrEqual(30);
        let first = FIRST_RANK;
        for (let i = 0; i < 1000; i++) first = rankBetween(null, first);
        expect(first.length).toBeLessThanOrEqual(30);
        // Splitting the same gap again and again halves it each time.
        let upper = 'j';
        for (let i = 0; i < 100; i++) upper = rankBetween('i', upper);
        expect(upper.length).toBeLessThanOrEqual(ORDER_RANK_MAX);
    });

    it('refuses, never cuts, a key past the bound', () => {
        let upper = 'j';
        expect(() => {
            for (let i = 0; i < 10_000; i++) upper = rankBetween('i', upper);
        }).toThrow(RankExhaustedError);
        expect(upper.length).toBeLessThanOrEqual(ORDER_RANK_MAX);
    });
});

describe('placeRank', () => {
    const order = ['b', 'd', 'f', 'h'];

    it('places between the two neighbours named', () => {
        const r = placeRank(order, { after: 'd', before: 'f' });
        expect(r.ok && compareRanks('d', r.rank) < 0 && compareRanks(r.rank, 'f') < 0).toBe(true);
    });

    it('places at either end, and at the end of an empty order', () => {
        const start = placeRank(order, { after: null, before: 'b' });
        expect(start.ok && compareRanks(start.rank, 'b') < 0).toBe(true);
        const end = placeRank(order, { after: 'h', before: null });
        expect(end.ok && compareRanks(end.rank, 'h') > 0).toBe(true);
        expect(placeRank([], { after: null, before: null })).toEqual({ ok: true, rank: FIRST_RANK });
        const anywhere = placeRank(order, { after: null, before: null });
        expect(anywhere.ok && compareRanks(anywhere.rank, 'h') > 0).toBe(true);
    });

    it('between lane neighbours with another lane’s card between them, lands before that card, so it is never another’s rank', () => {
        // A plot board lane shows b and h next to each other; d and f are in another act.
        const r = placeRank(order, { after: 'b', before: 'h' });
        expect(r.ok && compareRanks('b', r.rank) < 0 && compareRanks(r.rank, 'd') < 0).toBe(true);
        const before = placeRank(order, { after: null, before: 'h' });
        expect(before.ok && compareRanks('f', before.rank) < 0 && compareRanks(before.rank, 'h') < 0).toBe(true);
    });

    it('is stale when a neighbour is gone or the two no longer stand in that order', () => {
        expect(placeRank(order, { after: 'c', before: null })).toEqual({ ok: false, reason: 'ORDER_STALE' });
        expect(placeRank(order, { after: 'f', before: 'd' })).toEqual({ ok: false, reason: 'ORDER_STALE' });
    });

    it('says the gap is spent rather than throwing', () => {
        const tight = ['i', `i${'0'.repeat(ORDER_RANK_MAX - 2)}1`];
        expect(placeRank(tight, { after: 'i', before: tight[1] })).toEqual({ ok: false, reason: 'ORDER_RANK_EXHAUSTED' });
    });
});

describe('rebalancedRanks (Phase 3.H, issue #50 item 7)', () => {
    it.each([1, 2, 35, 36, 37, 500, 1_295, 1_296, 10_000])('gives %i short ranks, strictly ascending, of the stored shape', (n) => {
        const ranks = rebalancedRanks(n);
        expect(ranks).toHaveLength(n);
        expect(ranks.every(isRank)).toBe(true);
        for (let i = 1; i < n; i++) expect(compareRanks(ranks[i - 1], ranks[i])).toBe(-1);
        // A few characters, whatever the order's length: the space is opened up again.
        expect(Math.max(...ranks.map((r) => r.length))).toBeLessThanOrEqual(Math.ceil(Math.log(37 * (n + 1)) / Math.log(36)));
    });

    it('is deterministic, and empty for an empty order', () => {
        expect(rebalancedRanks(50)).toEqual(rebalancedRanks(50));
        expect(rebalancedRanks(0)).toEqual([]);
        expect(() => rebalancedRanks(-1)).toThrow(RangeError);
    });

    it('a spent gap has room again after a rebalance: every neighbour pair takes many more inserts', () => {
        // Spend one gap to the bound by splitting it again and again.
        const order = ['i', 'j'];
        let lower = 'i';
        let spent = false;
        for (let i = 0; i < 1_000 && !spent; i++) {
            const d = placeRank(order, { after: lower, before: null });
            if (!d.ok) {
                expect(d.reason).toBe('ORDER_RANK_EXHAUSTED');
                spent = true;
            } else {
                order.push(d.rank);
                lower = d.rank;
            }
        }
        expect(spent).toBe(true);
        const sorted = [...order].sort(compareRanks);
        // Rebalanced in the same order, the same gap (after the element that had spent it) is open again.
        const fresh = rebalancedRanks(sorted.length);
        const at = sorted.indexOf(lower);
        let after = fresh[at];
        for (let i = 0; i < 100; i++) {
            const d = placeRank(fresh, { after, before: null });
            expect(d.ok).toBe(true);
            if (d.ok) {
                fresh.push(d.rank);
                fresh.sort(compareRanks);
                after = d.rank;
            }
        }
    });
});
