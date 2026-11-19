import { NextRequest, NextResponse } from 'next/server';
import { toApiErrorResponse } from './types';
import { runWithRequestContext } from '@/lib/observability/context';
import { logger, extractErrorMeta } from '@/lib/observability/logger';
import { getTracer } from '@/lib/observability/tracing';
import { recordRequestMetrics, recordRequestError } from '@/lib/observability/metrics';
import { captureError } from '@/lib/observability/sentry';
import { safeErrorMessage, toReportableError } from '@/lib/observability/safe-error';
import { SpanStatusCode } from '@opentelemetry/api';
import {
    enforceRateLimit,
    isRateLimitBypassed,
    API_MUTATION_LIMIT,
    type RateLimitScope,
} from '@/lib/security/rate-limit-middleware';
import type { RateLimitConfig } from '@/lib/security/rate-limit';

/**
 * Every route handler is wrapped in `withApiErrorHandling`. Lifted from
 * inflect-compliance's `src/lib/errors/api.ts` (see docs/carve-manifest.md):
 * the API-version header is not carried.
 *
 * WHAT IS NEVER LOGGED (roadmap rule 4): the request body. The lines below
 * carry method, route, status, duration and an error's name and message —
 * nothing the handler read from the request. Only an AppError's message is
 * reported (usecases throw messages that describe, never quote); any other
 * error — a Prisma validation error renders the failed call's arguments —
 * reaches the log, the span and Sentry as its name, code and stack frames
 * only (`@/lib/observability/safe-error`).
 */

/** The id the proxy stamped, if it has the safe shape, else a new one. */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;
function resolveRequestId(header: string | null): string {
    return header && REQUEST_ID_SHAPE.test(header) ? header : crypto.randomUUID();
}



// ─── Rate-limit options for the shared wrapper ───────────────────────
//
// Mutation methods (POST/PUT/DELETE/PATCH) are rate-limited by default
// using API_MUTATION_LIMIT. Routes that need a stricter or looser
// policy pass an options object; routes that need to opt out entirely
// (webhook receivers, health checks — almost always already not using
// this wrapper anyway) pass `rateLimit: false`.

const MUTATION_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export interface ApiWrapperOptions {
    /**
     * Rate-limit policy for this route.
     *   - omitted          → default API_MUTATION_LIMIT on mutation methods
     *   - `false`          → skip rate limiting entirely for this route
     *   - `{ ... }`        → custom config/scope/userId resolver
     */
    rateLimit?: false | {
        config?: RateLimitConfig;
        scope?: string;
        getUserId?: (
            req: NextRequest,
        ) => string | null | undefined | Promise<string | null | undefined>;
    };
}

async function resolveRateLimitScope(
    req: NextRequest,
    options: ApiWrapperOptions['rateLimit'],
): Promise<RateLimitScope | null> {
    if (options === false) return null;
    if (!MUTATION_METHODS.has(req.method)) return null;
    if (isRateLimitBypassed()) return null;

    const config = options?.config ?? API_MUTATION_LIMIT;
    const scope = options?.scope ?? 'api-mutation';
    let userId: string | null | undefined;
    if (options?.getUserId) {
        try {
            userId = await options.getUserId(req);
        } catch {
            userId = null;
        }
    }
    return { scope, config, userId: userId ?? null };
}

/**
 * Next 16 calls a dynamic route's handler with `{ params: Promise<P> }`; a
 * handler types `params` as a Promise and awaits it. The wrapper forwards the
 * context untouched.
 */
type ApiRouteHandler<Context> = (req: NextRequest, ctx: Context) => Promise<NextResponse | Response>;

/**
 * High-Order Wrapper for all app/api routes.
 *
 * Catch all throws (ZodError, AppError, primitive errors) and shapes them
 * into standardized ApiErrorResponse JSON payloads.
 *
 * Also provides:
 * - x-request-id for correlation tracking
 * - Observability request context (AsyncLocalStorage)
 * - Structured request lifecycle logs (start/end/error) via Pino
 * - OpenTelemetry root span (api.request) with HTTP attributes
 * - Request metrics (count, duration, errors)
 * - **Rate limiting (the mutation tier):** POST/PUT/DELETE/PATCH default
 *   to API_MUTATION_LIMIT. Pass `{ rateLimit: { config, scope } }` for a
 *   stricter preset (LOGIN_LIMIT, EMAIL_DISPATCH_LIMIT), or
 *   `{ rateLimit: false }` to opt out.
 */
export function withApiErrorHandling<Context = unknown>(
    handler: (req: NextRequest, ctx: Context) => Promise<NextResponse | Response> | NextResponse | Response,
    options: ApiWrapperOptions = {},
): ApiRouteHandler<Context> {
    const impl = async (
        req: NextRequest,
        ctxIn: unknown,
    ): Promise<NextResponse | Response> => {
        const ctx = ctxIn as Context;
        const requestId = resolveRequestId(req.headers.get('x-request-id'));
        const route = req.nextUrl.pathname;
        const method = req.method;
        const startTime = performance.now();

        // Run the entire request inside an observability context so that
        // any downstream code can access requestId/route via getRequestContext().
        // workspaceId and userId are enriched later by Phase 0.3's context builder.
        return runWithRequestContext(
            { requestId, route, startTime },
            async () => {
                // ── OTel root span ──
                const tracer = getTracer();
                return tracer.startActiveSpan('api.request', async (span) => {
                    span.setAttributes({
                        'http.method': method,
                        'http.route': route,
                        'app.requestId': requestId,
                    });

                    // ── Request started ──
                    logger.info('request started', { component: 'api', method });

                    try {
                        // ── Rate-limit check (mutation tier) ──
                        const rateScope = await resolveRateLimitScope(req, options.rateLimit);
                        if (rateScope) {
                            const { response: rateBlocked } = enforceRateLimit(
                                req,
                                rateScope,
                            );
                            if (rateBlocked) {
                                const durationMs = Math.round(
                                    performance.now() - startTime,
                                );
                                span.setAttributes({
                                    'http.status_code': 429,
                                    'rate_limit.scope': rateScope.scope,
                                });
                                span.setStatus({ code: SpanStatusCode.OK });
                                recordRequestMetrics({
                                    method,
                                    route,
                                    status: 429,
                                    durationMs,
                                });
                                logger.warn('request rate-limited', {
                                    component: 'api',
                                    method,
                                    scope: rateScope.scope,
                                    durationMs,
                                });
                                rateBlocked.headers.set('x-request-id', requestId);
                                return rateBlocked;
                            }
                        }

                        // Execute the original handler
                        const response = await handler(req, ctx);

                        const status = response.status;
                        const durationMs = Math.round(performance.now() - startTime);

                        // ── Span + metrics ──
                        span.setAttributes({ 'http.status_code': status });
                        span.setStatus({ code: SpanStatusCode.OK });
                        recordRequestMetrics({ method, route, status, durationMs });

                        // ── Request completed ──
                        logger.info('request completed', {
                            component: 'api',
                            method,
                            status,
                            durationMs,
                        });

                        // Apply the request id to the response.
                        if (response instanceof NextResponse) {
                            response.headers.set('x-request-id', requestId);
                        } else if (response instanceof Response) {
                            // clone and append headers if plain standard Response
                            const newHeaders = new Headers(response.headers);
                            newHeaders.set('x-request-id', requestId);
                            return new Response(response.body, {
                                status: response.status,
                                statusText: response.statusText,
                                headers: newHeaders
                            });
                        }

                        return response;

                    } catch (error) {
                        // Unhandled throw! Map it.
                        const { payload, status } = toApiErrorResponse(error, requestId);
                        const durationMs = Math.round(performance.now() - startTime);

                        // ── Span error ──
                        span.setAttributes({ 'http.status_code': status });
                        span.setStatus({
                            code: SpanStatusCode.ERROR,
                            message: safeErrorMessage(error),
                        });
                        span.recordException(toReportableError(error));

                        // ── Metrics ──
                        recordRequestMetrics({ method, route, status, durationMs });
                        recordRequestError({ method, route, errorCode: payload.error.code });

                        // ── Sentry error capture (5xx only — skips 4xx) ──
                        captureError(error, {
                            requestId,
                            route,
                            method,
                            status,
                            errorCode: payload.error.code,
                        });

                        // ── Request failed ──
                        // A 4xx is the API refusing a request it was right to
                        // refuse (bad input, no session, no permission, absent
                        // row), so it is a warning. Only a 5xx is the server
                        // failing, and only that is an error. The request-error
                        // metric above still counts every failure.
                        const logFailure = status >= 500 ? logger.error : logger.warn;
                        logFailure(`request failed ${status} ${method} ${route}`, {
                            component: 'api',
                            method,
                            status,
                            durationMs,
                            errorCode: payload.error.code,
                            error: extractErrorMeta(error),
                        });

                        return NextResponse.json(payload, {
                            status,
                            headers: {
                                'x-request-id': requestId,
                                'Cache-Control': 'no-store, max-age=0'
                            }
                        });
                    } finally {
                        span.end();
                    }
                });
            },
        );
    };
    return impl as ApiRouteHandler<Context>;
}

