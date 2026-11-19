/**
 * The read tier — edge rate limiting for reads under `/api/`.
 *
 * Which requests are reads is `./edge-tier.ts`'s decision
 * (`classifyEdgeRequest`): GET, HEAD (Next answers it with the GET handler),
 * OPTIONS and any unlisted method, on any path that no spelling puts in the
 * auth tier and that is not a canonically spelled probe. This module only
 * counts them.
 *
 * The preset (`API_READ_LIMIT`, 120/min) lives with the others in
 * `src/lib/security/rate-limit.ts`; this module enforces it from
 * `src/proxy.ts`.
 *
 * Keyed (workspace, IP, user):
 *   rl:api-read:w:<workspaceSlug|none>:ip:<ip>:u:<userId|anon>
 * The workspace is read from a `/api/w/<slug>/…` path when there is one, so
 * one author's runaway tab in one workspace does not spend their budget in
 * another. `userId` is null for a signed-out caller;
 * passing it then gives each signed-in author their own bucket behind a NAT.
 *
 * Lifted from inflect-compliance's `src/lib/rate-limit/apiReadRateLimit.ts`
 * (tenant → workspace; every `/api/` read rather than only tenant routes; the
 * classification, probe exclusions included, moved to `./edge-tier.ts`; the
 * storage to `./window-store.ts`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { edgeLogger } from '@/lib/observability/edge-logger';
import { MemoryWindowStore, checkWindow, edgeClientIp, edgeRateLimitBypassed } from './window-store';

export function buildReadKey(workspaceSlug: string | null, ip: string, userId: string | null): string {
    return `w:${workspaceSlug ?? 'none'}:ip:${ip}:u:${userId ?? 'anon'}`;
}

const memory = new MemoryWindowStore();

/** @internal test-only */
export function _clearApiReadRateLimitMemory(): void {
    memory.clear();
}

/**
 * Count one request against the read tier. `workspaceSlug` is read by
 * `classifyEdgeRequest` from the decoded raw segments, as a `/api/w/[slug]`
 * route reads it, lowercased, so `/api/w/%61/…` and `/api/w/A/…` spend
 * workspace `a`'s budget rather than opening one each.
 */
export async function checkApiReadRateLimit(
    req: NextRequest,
    workspaceSlug: string | null,
    userId: string | null = null,
    requestId?: string,
): Promise<{ ok: boolean; response?: NextResponse }> {
    if (edgeRateLimitBypassed()) return { ok: true };
    const key = buildReadKey(workspaceSlug, edgeClientIp(req.headers), userId);
    let check;
    try {
        check = await checkWindow(memory, 'rl:api-read', key, {
            limit: API_READ_LIMIT.maxAttempts,
            windowMs: API_READ_LIMIT.windowMs,
        });
    } catch (err) {
        edgeLogger.error('API read rate limit exception, failing open', { component: 'rate-limit', requestId, err: String(err) });
        return { ok: true };
    }
    if (check.ok) return { ok: true };

    // No IP in the line: it is personal data. The request id ties it back.
    edgeLogger.warn('API read rate limit exceeded', {
        component: 'rate-limit',
        scope: 'api-read',
        requestId,
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
