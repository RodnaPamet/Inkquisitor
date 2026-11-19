/**
 * The embedding seam's outcome metric.
 *
 *   • `embeddings.requests` — Counter   { provider, outcome }
 *   • `embeddings.request.duration` — Histogram (ms) { provider, outcome }
 *
 * `outcome` is `ok` or the lower-cased `EmbeddingFailure`, so "went green",
 * "refused before sending" and "the service is down" are three different
 * series rather than one error count. Labels are closed sets — no workspace
 * id, no model id, no text — so cardinality is bounded by the type system.
 *
 * Carved from inflect-compliance's `src/lib/ai/embeddings/metrics.ts`
 * (docs/carve-manifest.md): the rerank operation is gone, and the meter is
 * Inkquisitor's (`src/lib/observability/metrics.ts` names it the same way).
 *
 * @module lib/ai/embeddings/metrics
 */
import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

import type { EmbeddingFailure, EmbeddingProviderId } from './types';

const METER_NAME = 'inkquisitor';

export type EmbeddingOutcome = 'ok' | Lowercase<EmbeddingFailure>;

let requests: Counter | null = null;
let duration: Histogram | null = null;

export function outcomeOf(reason: EmbeddingFailure | null): EmbeddingOutcome {
    return reason === null ? 'ok' : (reason.toLowerCase() as Lowercase<EmbeddingFailure>);
}

export function recordEmbeddingRequest(input: { provider: EmbeddingProviderId; outcome: EmbeddingOutcome; durationMs: number }): void {
    const meter = metrics.getMeter(METER_NAME);
    requests ??= meter.createCounter('embeddings.requests', { description: 'Embedding calls, by provider and outcome', unit: '1' });
    duration ??= meter.createHistogram('embeddings.request.duration', { description: 'Wall-clock duration of an embedding call', unit: 'ms' });
    const labels = { provider: input.provider, outcome: input.outcome };
    requests.add(1, labels);
    duration.record(Math.max(0, input.durationMs), labels);
}
