/**
 * Tracing — OpenTelemetry span helpers.
 *
 * Uses the no-op tracer until `initTelemetry()` installs a provider, so it is
 * safe to call unconditionally.
 *
 * SAFETY: span attributes are ids, enums and counts. Never a secret and never
 * author text — a span is exported to a third-party backend.
 *
 * Adapted from inflect-compliance's `src/lib/observability/tracing.ts`.
 */

import { trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import type { RequestContext } from '@/app-layer/types';
import { getRequestContext } from './context';
import { safeErrorMessage, toReportableError } from './safe-error';

const TRACER_NAME = 'inkquisitor';

export function getTracer(name: string = TRACER_NAME): Tracer {
    return trace.getTracer(name);
}

function contextAttributes(ctx: RequestContext): Record<string, string> {
    return {
        'app.requestId': ctx.requestId,
        ...(ctx.workspaceId && { 'app.workspaceId': ctx.workspaceId }),
        ...(ctx.userId && { 'app.userId': ctx.userId }),
        ...(ctx.role && { 'app.role': ctx.role }),
    };
}

async function inSpan<T>(span: Span, fn: () => Promise<T>): Promise<T> {
    try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
    } catch (error) {
        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: safeErrorMessage(error),
        });
        span.recordException(toReportableError(error));
        throw error;
    } finally {
        span.end();
    }
}

/** Wrap a usecase in a `usecase.<name>` span carrying the context's ids. */
export async function traceUsecase<T>(name: string, ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
    return getTracer().startActiveSpan(`usecase.${name}`, (span) => {
        span.setAttributes(contextAttributes(ctx));
        return inSpan(span, fn);
    });
}

/** A span around any operation, enriched with the current requestId. */
export async function traceOperation<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
): Promise<T> {
    const reqCtx = getRequestContext();
    const enriched = { ...(reqCtx?.requestId && { 'app.requestId': reqCtx.requestId }), ...attributes };
    return getTracer().startActiveSpan(name, (span) => {
        span.setAttributes(enriched);
        return inSpan(span, fn);
    });
}
