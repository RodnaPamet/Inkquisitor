/**
 * Edge middleware — the auth and read rate-limit tiers, and the request id.
 *
 *   /api/auth/**          → auth tier   (src/lib/rate-limit/authRateLimit.ts)
 *   GET /api/** (else)    → read tier   (src/lib/rate-limit/apiReadRateLimit.ts)
 *   POST/PUT/PATCH/DELETE → mutation tier, inside the route handler
 *                           (withApiErrorHandling), not here
 *
 * Every API response carries `x-request-id`: the caller's own when it sent
 * one, a new UUID otherwise, forwarded to the handler on the request so the
 * handler's log lines and the response agree. The auth tier's 429 carries it
 * too.
 *
 * Phase 0.3 extends this file with the session check and the workspace
 * access gate; the read tier then receives the signed-in user's id.
 *
 * Shape follows inflect-compliance's `src/middleware.ts`, cut to the two
 * rate-limit tiers.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { checkAuthRateLimit, isAuthRateLimited } from '@/lib/rate-limit/authRateLimit';
import { checkApiReadRateLimit, isApiReadRateLimited } from '@/lib/rate-limit/apiReadRateLimit';

const REQUEST_ID_HEADER = 'x-request-id';
/** A caller-supplied id is accepted only in this shape, so a header cannot inject into a log line. */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdFor(req: NextRequest): string {
    const offered = req.headers.get(REQUEST_ID_HEADER);
    return offered && REQUEST_ID_SHAPE.test(offered) ? offered : crypto.randomUUID();
}

function withRequestId(res: NextResponse, requestId: string): NextResponse {
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return res;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
    const { pathname } = req.nextUrl;
    const requestId = requestIdFor(req);

    if (isAuthRateLimited(pathname)) {
        const rl = await checkAuthRateLimit(req);
        if (!rl.ok && rl.response) return withRequestId(rl.response, requestId);
    } else if (isApiReadRateLimited(req.method, pathname)) {
        const rl = await checkApiReadRateLimit(req, null);
        if (!rl.ok && rl.response) return withRequestId(rl.response, requestId);
    }

    const headers = new Headers(req.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return withRequestId(NextResponse.next({ request: { headers } }), requestId);
}

export const config = {
    matcher: ['/api/:path*'],
};
