/**
 * The read tier — edge rate limiting for GET requests under `/api/`.
 *
 * The preset (`API_READ_LIMIT`, 120/min) lives with the others in
 * `src/lib/security/rate-limit.ts`; this module enforces it from
 * `src/middleware.ts`.
 *
 * Keyed (workspace, IP, user):
 *   rl:api-read:w:<workspaceSlug|none>:ip:<ip>:u:<userId|anon>
 * The workspace is read from a `/api/w/<slug>/…` path when there is one, so
 * one author's runaway tab in one workspace does not spend their budget in
 * another. `userId` is null until Phase 0.3 authenticates in the middleware;
 * passing it then gives each signed-in author their own bucket behind a NAT.
 *
 * Lifted from inflect-compliance's `src/lib/rate-limit/apiReadRateLimit.ts`
 * (tenant → workspace; every `/api/` GET rather than only tenant routes; the
 * storage moved to `./window-store.ts`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { edgeLogger } from '@/lib/observability/edge-logger';
import { MemoryWindowStore, checkWindow, edgeClientIp, edgeRateLimitBypassed } from './window-store';

/**
 * Paths the read tier never throttles. Health probes must answer during an
 * attack; `/api/auth/` has a tier of its own. (inflect-compliance also exempts
 * its OpenAPI `/api/docs`; Inkquisitor ships no such route, so no path is
 * exempt for it — add one here only with the route it serves.) Exact-or-prefix-with-slash, so
 * `/api/health` matches and `/api/healthcheck` does not.
 */
export const READ_TIER_EXCLUDED_PATHS: readonly string[] = [
    '/api/health',
    '/api/livez',
    '/api/readyz',
    '/api/auth',
];

export function isApiReadRateLimited(method: string, pathname: string): boolean {
    if (method !== 'GET') return false;
    if (!pathname.startsWith('/api/')) return false;
    return !READ_TIER_EXCLUDED_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/** The workspace slug in a `/api/w/<slug>/…` path, or null. */
export function extractWorkspaceSlug(pathname: string): string | null {
    const m = /^\/api\/w\/([^/]+)/.exec(pathname);
    return m ? m[1] : null;
}

export function buildReadKey(workspaceSlug: string | null, ip: string, userId: string | null): string {
    return `w:${workspaceSlug ?? 'none'}:ip:${ip}:u:${userId ?? 'anon'}`;
}

const memory = new MemoryWindowStore();

/** @internal test-only */
export function _clearApiReadRateLimitMemory(): void {
    memory.clear();
}

export async function checkApiReadRateLimit(
    req: NextRequest,
    userId: string | null = null,
): Promise<{ ok: boolean; response?: NextResponse }> {
    if (edgeRateLimitBypassed()) return { ok: true };
    const workspaceSlug = extractWorkspaceSlug(req.nextUrl.pathname);
    const key = buildReadKey(workspaceSlug, edgeClientIp(req.headers), userId);
    let check;
    try {
        check = await checkWindow(memory, 'rl:api-read', key, {
            limit: API_READ_LIMIT.maxAttempts,
            windowMs: API_READ_LIMIT.windowMs,
        });
    } catch (err) {
        edgeLogger.error('API read rate limit exception, failing open', { component: 'rate-limit', err: String(err) });
        return { ok: true };
    }
    if (check.ok) return { ok: true };

    // No IP in the line: it is personal data. The request id ties it back.
    edgeLogger.warn('API read rate limit exceeded', {
        component: 'rate-limit',
        scope: 'api-read',
        workspaceSlug: workspaceSlug ?? '(none)',
    });
    return {
        ok: false,
        response: NextResponse.json(
            {
                error: {
                    code: 'RATE_LIMITED',
                    scope: 'api-read',
                    message: `Too many read requests. Retry after ${check.retryAfter} seconds.`,
                    retryAfterSeconds: check.retryAfter,
                },
            },
            {
                status: 429,
                headers: {
                    'Retry-After': String(check.retryAfter),
                    'X-RateLimit-Limit': String(check.limit),
                    'X-RateLimit-Remaining': '0',
                    'X-RateLimit-Reset': String(check.reset),
                },
            },
        ),
    };
}
