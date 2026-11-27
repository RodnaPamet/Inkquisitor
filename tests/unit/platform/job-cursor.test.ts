/**
 * A multi-workspace discovery's round-robin (Phase 4.H-b, #60.4): taken in
 * workspace order after the cursor, wrapping round, so every busy workspace is
 * reached within ⌈busy ÷ per-tick bound⌉ ticks. Pure (the reads are stubs over a list).
 */
import { fromCursor, roundRobin } from '@/app-layer/repositories/job-cursor.repository';
import { withPassedOver, CONTINUITY_PASSED_OVER_MAX } from '@/lib/continuity/vocabulary';

const busy = Array.from({ length: 7 }, (_, i) => ({ workspaceId: `w${i}` }));
const after = async (c: string, n: number) => busy.filter((w) => w.workspaceId > c).slice(0, n);
const upTo = async (c: string, n: number) => busy.filter((w) => w.workspaceId <= c).slice(0, n);

it('every workspace is served within ⌈busy ÷ take⌉ ticks, whatever the order of their backlogs', async () => {
    let cursor = '';
    const seen = new Map<string, number>();
    for (let tick = 1; tick <= Math.ceil(busy.length / 3); tick++) {
        const r = await fromCursor(cursor, 3, after, upTo);
        r.items.forEach((w) => seen.has(w.workspaceId) || seen.set(w.workspaceId, tick));
        cursor = r.next;
    }
    expect(seen.size).toBe(busy.length);
});

it('wraps round from the start, and a tick with nothing keeps the cursor', async () => {
    expect((await fromCursor('w5', 3, after, upTo)).items.map((w) => w.workspaceId)).toEqual(['w6', 'w0', 'w1']);
    expect(await fromCursor('w5', 3, async () => [], async () => [])).toEqual({ items: [], next: 'w5' });
});

it('roundRobin interleaves the lists and cuts at take', () => {
    expect(roundRobin([[1, 2, 3], [4], [5, 6]], 5)).toEqual([1, 4, 5, 2, 6]);
});

it('a passed-over list is bounded, deduplicated, and says when it overflowed (D32)', () => {
    expect(withPassedOver(['a'], ['a', 'b'])).toEqual({ list: ['a', 'b'], cut: false });
    const full = Array.from({ length: CONTINUITY_PASSED_OVER_MAX }, (_, i) => `k${i}`);
    expect(withPassedOver(full, ['new'])).toEqual({ list: full, cut: true });
});
