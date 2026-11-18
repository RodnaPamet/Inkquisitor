/**
 * OpenTelemetry bootstrap — traces and metrics over OTLP/HTTP.
 *
 * GUARDED: does nothing unless OTEL_ENABLED=true, so development and tests
 * pay nothing and need no collector. The SDK modules are imported
 * dynamically for the same reason.
 *
 * Called from `src/instrumentation.ts` (web) and `scripts/worker.ts` (worker),
 * each its own process. `shutdownTelemetry` drains both providers on the
 * graceful-shutdown path, bounded by a budget.
 *
 * Adapted from inflect-compliance's `src/lib/observability/instrumentation.ts`
 * (the observable-gauge rebind registry is not carried: nothing here
 * registers a gauge yet).
 */

import { env } from '@/env';
import { pinoInstance } from './logger';

let initialized = false;
let shutdownFn: (() => Promise<void>) | null = null;

export async function initTelemetry(): Promise<void> {
    if (initialized) return;
    initialized = true;
    if (env.OTEL_ENABLED !== 'true') return;

    const serviceName = env.OTEL_SERVICE_NAME || 'inkquisitor';
    const otlpEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const semConv = await import('@opentelemetry/semantic-conventions');
    const { TracerProvider, BatchSpanProcessor } = await import('@opentelemetry/sdk-trace');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { MeterProvider, PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const { AsyncLocalStorageContextManager } = await import('@opentelemetry/context-async-hooks');
    const { trace, context, propagation, metrics } = await import('@opentelemetry/api');
    const { CompositePropagator, W3CTraceContextPropagator, W3CBaggagePropagator } = await import('@opentelemetry/core');

    const resource = resourceFromAttributes({
        [semConv.ATTR_SERVICE_NAME]: serviceName,
        [semConv.ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.0.0',
        'deployment.environment': env.NODE_ENV,
    });

    const tracerProvider = new TracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }) })],
    });

    // sdk-trace 3.x has no `register()`; its three effects are made by hand.
    // Without the context manager every span is a root; without the
    // propagator a job's trace carrier comes back empty.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(tracerProvider);
    propagation.setGlobalPropagator(
        new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
    );

    const meterProvider = new MeterProvider({
        resource,
        readers: [
            new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
                exportIntervalMillis: 30_000,
            }),
        ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    shutdownFn = async () => {
        await Promise.all([
            tracerProvider.shutdown().catch(() => undefined),
            meterProvider.shutdown().catch(() => undefined),
        ]);
    };

    pinoInstance.info({ component: 'otel', serviceName, otlpEndpoint }, 'Telemetry initialized');
}

export function isTelemetryInitialized(): boolean {
    return initialized;
}

/** Drain both providers, bounded by `timeoutMs`. Never throws; idempotent. */
export async function shutdownTelemetry(timeoutMs = 2_000): Promise<void> {
    if (!shutdownFn) return;
    const fn = shutdownFn;
    shutdownFn = null;
    initialized = false;
    await Promise.race([fn(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
}

/** @internal test-only */
export function _resetTelemetryForTesting(): void {
    initialized = false;
    shutdownFn = null;
}
