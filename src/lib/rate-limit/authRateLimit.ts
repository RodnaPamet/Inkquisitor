/**
 * The auth tier — edge rate limiting for `/api/auth/**`.
 *
 * Runs in `src/middleware.ts` before authentication, so it is keyed on the
 * caller's IP plus a short hash of the User-Agent (to soften the shared
 * bucket behind a NAT), never on a user. Three strictness levels:
 *
 *   high    10/min  sign-in, callback, sign-out — credential guessing lives here
 *   medium  30/min  session probes
 *   low     60/min  csrf, providers and other getters
 *
 * Phase 0.3 adds the routes; the tier is in place first so the first sign-in
 * route is throttled the day it lands.
 *
 * Lifted from inflect-compliance's `src/lib/rate-limit/authRateLimit.ts`; the
 * storage moved to `./window-store.ts` (Upstash only when configured, a
 * memory window with a lazy sweep otherwise).
 */
import { NextRequest, NextResponse } from 'next/server';
import { edgeLogger } from '@/lib/observability/edge-logger';
import {
    MemoryWindowStore,
    checkWindow,
    edgeClientIp,
    edgeRateLimitBypassed,
    type WindowPolicy,
} from './window-store';

export type AuthEndpointTier = 'high' | 'medium' | 'low';

export const AUTH_TIER_POLICIES: Readonly<Record<AuthEndpointTier, WindowPolicy>> = {
    high: { limit: 10, windowMs: 60_000 },
    medium: { limit: 30, windowMs: 60_000 },
    low: { limit: 60, windowMs: 60_000 },
};

/** True when a path belongs to the auth tier. */
export function isAuthRateLimited(pathname: string): boolean {
    return pathname === '/api/auth' || pathname.startsWith('/api/auth/');
}

export function classifyAuthEndpoint(pathname: string): AuthEndpointTier {
    if (
        pathname.startsWith('/api/auth/signin') ||
        pathname.startsWith('/api/auth/callback') ||
        pathname.startsWith('/api/auth/signout') ||
        pathname.startsWith('/api/auth/register') ||
        pathname.startsWith('/api/auth/forgot-password') ||
        pathname.startsWith('/api/auth/reset-password')
    ) {
        return 'high';
    }
    if (pathname.startsWith('/api/auth/session')) return 'medium';
    return 'low';
}

async function clientKey(req: NextRequest): Promise<string> {
    const ip = edgeClientIp(req.headers);
    const ua = req.headers.get('user-agent') || 'unknown';
    let uaHash = 'unknown';
    try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ua));
        uaHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
    } catch {
        // crypto.subtle unavailable: share the IP's bucket.
    }
    return `${ip}:${uaHash}`;
}

const memory = new MemoryWindowStore();

/** @internal test-only */
export function _clearAuthRateLimitMemory(): void {
    memory.clear();
}

export async function checkAuthRateLimit(req: NextRequest): Promise<{ ok: boolean; response?: NextResponse; headers?: Headers }> {
    if (edgeRateLimitBypassed()) return { ok: true };
    try {
        const { pathname } = req.nextUrl;
        const tier = classifyAuthEndpoint(pathname);
        const check = await checkWindow(memory, `rl:auth:${tier}`, await clientKey(req), AUTH_TIER_POLICIES[tier]);
        const headers = new Headers({
            'X-RateLimit-Limit': String(check.limit),
            'X-RateLimit-Remaining': String(check.remaining),
            'X-RateLimit-Reset': String(check.reset),
        });
        if (!check.ok) {
            edgeLogger.warn('auth rate limit exceeded', { component: 'rate-limit', tier, pathname });
            headers.set('Retry-After', String(check.retryAfter));
            return {
                ok: false,
                response: NextResponse.json(
                    { error: { code: 'RATE_LIMITED', scope: 'auth', retryAfterSeconds: check.retryAfter } },
                    { status: 429, headers },
                ),
            };
        }
        return { ok: true, headers };
    } catch (error) {
        // Fail open: an Upstash outage must not stop people signing in.
        edgeLogger.error('auth rate limit exception, failing open', { component: 'rate-limit', err: String(error) });
        return { ok: true };
    }
}
