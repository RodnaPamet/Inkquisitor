/**
 * Observability request context — AsyncLocalStorage, request-scoped.
 *
 * Gives logging, tracing and error reporting the request's `requestId`,
 * `route` and (once Phase 0.3 resolves them) `workspaceId` / `userId` without
 * threading them through every call.
 *
 * This is for OBSERVABILITY only, never authorization. The authorization
 * context (`RequestContext`, `src/app-layer/types.ts`) is passed explicitly as
 * the first argument of every usecase and repository call.
 *
 * SAFETY: never store secrets, tokens or author text in this context — every
 * field here is copied onto every log line and span of the request.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextData {
    /** Unique request identifier for correlation */
    requestId: string;
    /** Workspace id (resolved after authentication, Phase 0.3) */
    workspaceId?: string;
    /** Authenticated user id (Phase 0.3) */
    userId?: string;
    /** Request route (pathname) or `job:<name>` for a background job */
    route?: string;
    /** High-resolution start time (`performance.now()`) for durations */
    startTime: number;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContextData>();

/** Run `fn` inside an observability request context. */
export function runWithRequestContext<T>(data: RequestContextData, fn: () => T): T {
    return asyncLocalStorage.run(data, fn);
}

/** The current request context, or undefined outside a request scope. */
export function getRequestContext(): RequestContextData | undefined {
    return asyncLocalStorage.getStore();
}

/** The current requestId, or "unknown" outside a request scope. */
export function getRequestId(): string {
    return asyncLocalStorage.getStore()?.requestId ?? 'unknown';
}

/**
 * Enrich the current context (typically after authentication resolves the
 * workspace and user). Returns false when no context is active.
 */
export function mergeRequestContext(
    partial: Partial<Omit<RequestContextData, 'requestId' | 'startTime'>>,
): boolean {
    const store = asyncLocalStorage.getStore();
    if (!store) return false;
    Object.assign(store, partial);
    return true;
}
