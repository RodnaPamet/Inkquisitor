/**
 * The ledger's counters (D17): a released reservation is counted, with the
 * worst case it held, so spend that may have gone uncounted is visible.
 */
import { metrics } from '@opentelemetry/api';

const added: Array<[string, number]> = [];
jest.spyOn(metrics, 'getMeter').mockReturnValue({
    createCounter: (name: string) => ({ add: (n: number) => added.push([name, n]) }),
} as never);

import { recordReservationsReleased } from '@/lib/ai/ledger-metrics';

it('counts released reservations and the micro-dollars they held; nothing for none', () => {
    recordReservationsReleased(0, 0);
    expect(added).toEqual([]);
    recordReservationsReleased(2, 1_800_000);
    expect(added).toEqual([
        ['ai.reservations.released', 2],
        ['ai.reservations.released_micro_usd', 1_800_000],
    ]);
});
