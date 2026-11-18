/**
 * Sentry error reporting — server side. A no-op unless SENTRY_DSN is set.
 *
 * SAFETY (roadmap rule 4 — author text never reaches an error sink):
 *   - the SDK's data collection is PINNED off in `init`, not inherited: a
 *     default the SDK may widen in a later major must not decide it;
 *   - `scrubEvent` (beforeSend) drops request bodies, query strings, cookies
 *     and authorization headers, the user's IP address, and breadcrumb URLs'
 *     sensitive parameters;
 *   - an error's message is reported only when it is our own (an AppError):
 *     `captureError` hands Sentry `toReportableError(error)`, and
 *     `scrubEvent` replaces every exception value whose type is a Prisma
 *     error, or whose original exception is not an AppError, with the
 *     withheld message — so an error Sentry's own instrumentation caught
 *     (not through `captureError`) is held to the same rule (`./safe-error`);
 *   - 4xx errors are not reported (`captureError`).
 *
 * Adapted from inflect-compliance's `src/lib/observability/sentry.ts`.
 */

import * as Sentry from '@sentry/nextjs';
import type { ErrorEvent, EventHint } from '@sentry/nextjs';
import { env } from '@/env';
import { getRequestContext } from './context';
import { WITHHELD_MESSAGE, isPrismaErrorName, mayReportMessage, toReportableError } from './safe-error';

let initialized = false;

const SENSITIVE_PARAMS = new Set([
    'code', 'state', 'token', 'access_token', 'refresh_token', 'id_token', 'client_secret', 'secret',
]);

const IGNORED_ERROR_PATTERNS = ['NEXT_REDIRECT', 'NEXT_NOT_FOUND', 'DYNAMIC_SERVER_USAGE'];

/** Redact sensitive query parameters from a URL string. */
export function redactUrl(url: string): string {
    try {
        const parsed = new URL(url, 'http://placeholder');
        for (const param of SENSITIVE_PARAMS) {
            if (parsed.searchParams.has(param)) parsed.searchParams.set(param, '[Redacted]');
        }
        return url.startsWith('http') ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
    } catch {
        return url;
    }
}

/**
 * The beforeSend hook. Exported so a test can feed it an event carrying every
 * kind of private data and assert none of it leaves.
 */
export function scrubEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent | null {
    const error = hint?.originalException;
    if (error instanceof Error) {
        for (const pattern of IGNORED_ERROR_PATTERNS) {
            if (error.message.includes(pattern) || error.name.includes(pattern)) return null;
        }
    }

    if (event.request) {
        if (event.request.headers) {
            const headers = { ...event.request.headers };
            for (const name of Object.keys(headers)) {
                const lower = name.toLowerCase();
                if (lower === 'authorization' || lower === 'cookie' || lower === 'x-api-key') delete headers[name];
            }
            event.request.headers = headers;
        }
        // Never a request body: it is where author text travels.
        if (event.request.data !== undefined) event.request.data = '[Filtered]';
        if (event.request.cookies) delete event.request.cookies;
        if (event.request.url) event.request.url = redactUrl(event.request.url);
        if (event.request.query_string) event.request.query_string = '[Filtered]';
    }

    if (event.user) delete event.user.ip_address;

    // An exception's value is its message. Only an AppError's may leave.
    const values = event.exception?.values;
    if (values) {
        // An AppError's own entry keeps its value; every other entry (a
        // non-AppError original, a linked `cause`, a Prisma type) does not.
        const own = mayReportMessage(error) ? error : undefined;
        for (const v of values) {
            const isOwn = own !== undefined && v.type === own.name && v.value === own.message;
            if (!isOwn || isPrismaErrorName(v.type)) v.value = WITHHELD_MESSAGE;
        }
    }

    if (event.breadcrumbs) {
        for (const crumb of event.breadcrumbs) {
            if (crumb.data?.url && typeof crumb.data.url === 'string') crumb.data.url = redactUrl(crumb.data.url);
        }
    }
    return event;
}

/** Initialise Sentry once. A no-op without SENTRY_DSN. */
export function initSentry(): void {
    if (initialized) return;
    initialized = true;
    const dsn = env.SENTRY_DSN;
    if (!dsn) return;

    Sentry.init({
        dsn,
        environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
        // Performance tracing is OpenTelemetry's job; Sentry is errors only.
        tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE ?? 0,
        // PINNED, not inherited — every category whose SDK default collects is
        // set off. `stackFrameVariables` matters most here: a throw inside code
        // holding an author's answer would put that answer in a frame local.
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: { request: false, response: false },
            httpBodies: [],
            urlQueryParams: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            stackFrameVariables: false,
        },
        beforeSend: scrubEvent,
        ignoreErrors: ['ResizeObserver loop', 'Non-Error exception captured'],
    });
}

/** True when this process has a live Sentry client. */
export function isSentryInitialized(): boolean {
    return Sentry.getClient() !== undefined;
}

/** Flush and close the client, bounded by `timeoutMs`. Never throws. */
export async function shutdownSentry(timeoutMs = 2_000): Promise<void> {
    if (!Sentry.getClient()) return;
    await Promise.race([
        Sentry.close(timeoutMs).then(() => undefined, () => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 100).unref()),
    ]);
}

/**
 * Capture a server error with request correlation. 4xx is skipped: those are
 * the API refusing a request it was right to refuse. Returns the event id.
 */
export function captureError(
    error: unknown,
    extra?: { requestId?: string; route?: string; method?: string; status?: number; errorCode?: string },
): string | undefined {
    if (extra?.status && extra.status < 500) return undefined;
    if (!Sentry.getClient()) return undefined;
    const ctx = getRequestContext();
    let eventId: string | undefined;
    Sentry.withScope((scope) => {
        scope.setTag('requestId', extra?.requestId || ctx?.requestId || 'unknown');
        const route = extra?.route || ctx?.route;
        if (route) scope.setTag('route', route);
        if (extra?.method) scope.setTag('method', extra.method);
        if (extra?.status) scope.setTag('statusCode', String(extra.status));
        if (extra?.errorCode) scope.setTag('errorCode', extra.errorCode);
        // Ids only: never an email or a name.
        if (ctx?.userId || ctx?.workspaceId) {
            scope.setUser({ id: ctx?.userId });
            if (ctx?.workspaceId) scope.setTag('workspaceId', ctx.workspaceId);
        }
        eventId = Sentry.captureException(toReportableError(error));
    });
    return eventId;
}
