/**
 * The ledger's OpenTelemetry counters (Phase 2.H, D17).
 *
 *   ai.reservations.released            Counter  expired, unsettled reservations released, charged nothing
 *   ai.reservations.released_micro_usd  Counter  the worst cases those reservations held, micro-US-dollars
 *
 * An expired reservation is a call whose process died (or stalled past its
 * deadline and the grace) before it settled. It is released rather than
 * charged (D17), so what such a call may have cost the provider is not on the
 * month: these counters are where that possible loss is seen. No labels:
 * workspace ids are never metric labels (`src/lib/observability/metrics.ts`);
 * the log line `ai.reservation_released` names them.
 *
 * Instruments are created lazily, so the global MeterProvider can be installed
 * first; before `initTelemetry()` they are the API's no-op instruments.
 */
import { metrics, type Counter } from '@opentelemetry/api';

const METER_NAME = 'inkquisitor';

let released: Counter | null = null;
let releasedMicroUsd: Counter | null = null;

/** Count `count` released reservations that held `reservedMicroUsd` between them. */
export function recordReservationsReleased(count: number, reservedMicroUsd: number): void {
    if (count <= 0) return;
    const meter = metrics.getMeter(METER_NAME);
    released ??= meter.createCounter('ai.reservations.released', { description: 'Expired, unsettled model-call reservations released without a charge (D17)', unit: '1' });
    releasedMicroUsd ??= meter.createCounter('ai.reservations.released_micro_usd', {
        description: 'The worst cases the released reservations held: spend that may have gone uncounted (D17)',
        unit: 'uUSD',
    });
    released.add(count);
    if (reservedMicroUsd > 0) releasedMicroUsd.add(reservedMicroUsd);
}
