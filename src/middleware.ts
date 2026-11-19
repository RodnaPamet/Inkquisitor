/**
 * Edge middleware — the auth and read rate-limit tiers, and the request id.
 *
 * Every request is classified once (`classifyEdgeRequest`, over every
 * spelling Next could route the path by) and charged to its tier by one
 * unconditional call (`enforceEdgeRateLimit`):
 *
 *   any spelling under /api/auth → auth tier   (src/lib/rate-limit/authRateLimit.ts)
 *   a canonically spelled probe  → exempt
 *   POST/PUT/PATCH/DELETE (else) → mutation tier, inside the route handler
 *                                  (withApiErrorHandling), not here
 *   anything else (GET, HEAD, …) → read tier   (src/lib/rate-limit/apiReadRateLimit.ts)
 *
 * See `src/lib/rate-limit/edge-tier.ts` for why: the raw pathname let
 * `/api/%61uth/…`, `//api/…` and HEAD requests escape both tiers, and a
 * single decode-and-resolve path let `…/x%2F..%2F..%2Fapi%2Fhealth` pass as
 * a probe.
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
import { classifyEdgeRequest, enforceEdgeRateLimit } from '@/lib/rate-limit/edge-tier';

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
    const requestId = requestIdFor(req);

    const tier = classifyEdgeRequest(req.method, req.nextUrl.pathname);
    const verdict = await enforceEdgeRateLimit(req, tier, null);
    if (!verdict.ok) return withRequestId(verdict.response, requestId);

    const headers = new Headers(req.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return withRequestId(NextResponse.next({ request: { headers } }), requestId);
}

export const config = {
    matcher: ['/api/:path*'],
};
