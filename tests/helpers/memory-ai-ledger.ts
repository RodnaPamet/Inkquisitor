/**
 * An in-memory `AiLedger` for unit tests of `callStructured`: the same rule as
 * the database ledger (settled spend + live reservations + the request must
 * fit under the ceiling; one reservation per call, replaced on re-reserve),
 * with every reservation request and settled record kept for assertions. The
 * database ledger, and its behaviour under concurrency, are tested against a
 * real PostgreSQL in tests/integration/ai-ledger.test.ts.
 */
import type { AiCallRecord, AiLedger, ReserveRequest, ReserveResult } from '@/lib/ai/call-record';
import { spendPeriod } from '@/lib/ai/call-record';

export interface MemoryLedger extends AiLedger {
    readonly records: AiCallRecord[];
    readonly reserveRequests: ReserveRequest[];
    /** Settled spend so far. */
    spent: number;
    /** Live reservations by call id. */
    readonly held: Map<string, number>;
}

export function memoryLedger(opts: { alreadySpent?: number; failSettle?: boolean } = {}): MemoryLedger {
    const ledger: MemoryLedger = {
        records: [],
        reserveRequests: [],
        spent: opts.alreadySpent ?? 0,
        held: new Map(),
        async reserve(request): Promise<ReserveResult> {
            ledger.reserveRequests.push(request);
            const others = [...ledger.held.entries()].filter(([id]) => id !== request.callId).reduce((n, [, v]) => n + v, 0);
            const period = spendPeriod(request.startedAt);
            if (ledger.spent + others + request.amountMicroUsd > request.ceilingMicroUsd) {
                return { ok: false, period, spentMicroUsd: ledger.spent, reservedMicroUsd: others, ceilingMicroUsd: request.ceilingMicroUsd };
            }
            ledger.held.set(request.callId, request.amountMicroUsd);
            return { ok: true, period };
        },
        async settle(record) {
            if (opts.failSettle) throw new Error('ledger unavailable');
            ledger.held.delete(record.id);
            ledger.spent += record.costMicroUsd;
            ledger.records.push(record);
        },
    };
    return ledger;
}
