/**
 * Trace propagation across the queue boundary.
 *
 * `enqueue` injects the active W3C trace context into the job payload under
 * `OTEL_CARRIER_KEY`; the worker reads it, strips it before the executor sees
 * the payload, and runs the job in a span parented on the enqueue span. So a
 * trace reads HTTP handler ▸ enqueue ▸ execute.
 *
 * Adapted from inflect-compliance's `src/lib/observability/job-trace.ts`.
 */
import {
    propagation,
    trace,
    context as otelContext,
    SpanStatusCode,
    type Span,
    type Attributes,
} from '@opentelemetry/api';
import { safeErrorMessage, toReportableError } from './safe-error';

export const OTEL_CARRIER_KEY = '__otel_carrier' as const;

const WORKER_TRACER = 'inkquisitor.worker';

export function captureTraceCarrier(): Record<string, string> {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    return carrier;
}

export function readTraceCarrier(data: unknown): Record<string, string> {
    if (data && typeof data === 'object' && OTEL_CARRIER_KEY in data) {
        const carrier = (data as Record<string, unknown>)[OTEL_CARRIER_KEY];
        if (carrier && typeof carrier === 'object') return carrier as Record<string, string>;
    }
    return {};
}

export function stripTraceCarrier<T extends Record<string, unknown>>(data: T): Omit<T, typeof OTEL_CARRIER_KEY> {
    if (!data || typeof data !== 'object' || !(OTEL_CARRIER_KEY in data)) return data;
    const clone = { ...data };
    delete clone[OTEL_CARRIER_KEY];
    return clone;
}

export async function runJobInTraceContext<T>(
    carrier: Record<string, string>,
    spanName: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>,
): Promise<T> {
    const parentCtx = propagation.extract(otelContext.active(), carrier);
    const tracer = trace.getTracer(WORKER_TRACER);
    return otelContext.with(parentCtx, () =>
        tracer.startActiveSpan(spanName, { attributes }, async (span: Span) => {
            try {
                const result = await fn(span);
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
            } catch (err) {
                span.recordException(toReportableError(err));
                span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorMessage(err) });
                throw err;
            } finally {
                span.end();
            }
        }),
    );
}
