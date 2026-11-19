/**
 * Edge middleware — the auth and read rate-limit tiers, the workspace access
 * gate, and the request id. In that order.
 *
 *   1. THE RATE-LIMIT TIERS, for requests any spelling puts under `/api`
 *      (`isApiPath`). Classified once (`classifyEdgeRequest`) and charged by
 *      one unconditional call (`enforceEdgeRateLimit`):
 *        under /api/auth             → auth tier (authRateLimit.ts)
 *        a canonically spelled probe → exempt
 *        POST/PUT/PATCH/DELETE       → mutation tier, in the route handler
 *        anything else               → read tier (apiReadRateLimit.ts), keyed on
 *                                      the signed-in user when there is one
 *      See src/lib/rate-limit/edge-tier.ts for why every spelling is judged.
 *      Charged BEFORE the gate, so a request the gate refuses has still spent
 *      its budget: probing slugs, or spelling a sign-in so that one of its
 *      spellings names a workspace, is counted like any other request.
 *      Workspace PAGES are not charged: the read tier budgets API reads.
 *
 *   2. THE WORKSPACE GATE (Phase 0.3). A request any spelling of whose path
 *      names `/w/<slug>/…` or `/api/w/<slug>/…` (`workspaceGateTarget`) needs a
 *      session whose JWT claims a membership in every slug named
 *      (`checkWorkspaceAccess`, src/lib/auth/workspace-gate.ts):
 *        no session        page → /login?callbackUrl=…   API → 401
 *        no membership     page → /no-workspace          API → 403
 *        not this slug     page → /no-workspace          API → 403
 *      The edge reads the JWT claim only — no database. It is a pre-filter: the
 *      route's own `getWorkspaceCtx` re-checks the membership in the database,
 *      and the `jwt` callback (which the edge does not run) refuses a revoked
 *      session there. A capped claim list defers a miss to that server check.
 *
 *   3. Every response carries `x-request-id`: the caller's own when it has the
 *      safe shape, a new UUID otherwise, forwarded to the handler.
 *
 * Shape follows inflect-compliance's `src/middleware.ts` (see
 * docs/carve-manifest.md), cut to these tiers and one gate.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { classifyEdgeRequest, edgePathSpellings, enforceEdgeRateLimit } from '@/lib/rate-limit/edge-tier';
import { authSecret } from '@/lib/auth/auth-secret';
import { checkWorkspaceAccess, workspaceGateTarget } from '@/lib/auth/workspace-gate';

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

/** True when any spelling Next could route the path by is under `/api`. */
export function isApiPath(rawPathname: string): boolean {
    const spelt = edgePathSpellings(rawPathname);
    return [spelt.raw, spelt.decoded, spelt.resolved].some((p) => p === '/api' || p.startsWith('/api/'));
}

function refuse(kind: 'page' | 'api', status: 401 | 403, req: NextRequest, requestId: string): NextResponse {
    if (kind === 'api') {
        const code = status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
        const message = status === 401 ? 'Sign in to continue.' : 'You do not have access to this workspace.';
        return withRequestId(NextResponse.json({ error: { code, message, requestId } }, { status }), requestId);
    }
    const url = req.nextUrl.clone();
    if (status === 401) {
        url.pathname = '/login';
        url.search = `?callbackUrl=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    } else {
        url.pathname = '/no-workspace';
        url.search = '';
    }
    return withRequestId(NextResponse.redirect(url), requestId);
}

async function readToken(req: NextRequest) {
    try {
        return await getToken({ req, secret: authSecret() });
    } catch {
        // An unreadable cookie is no session.
        return null;
    }
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
    const requestId = requestIdFor(req);
    const pathname = req.nextUrl.pathname;
    const gate = workspaceGateTarget(pathname);
    const api = isApiPath(pathname);
    const token = gate || api ? await readToken(req) : null;
    const userId = typeof token?.userId === 'string' ? token.userId : null;

    if (api) {
        const tier = classifyEdgeRequest(req.method, pathname);
        const verdict = await enforceEdgeRateLimit(req, tier, userId);
        if (!verdict.ok) return withRequestId(verdict.response, requestId);
    }

    if (gate) {
        if (!userId) return refuse(gate.kind, 401, req, requestId);
        const verdict = checkWorkspaceAccess(gate.slugs, token?.memberships, token?.membershipsTruncated === true);
        if (verdict !== 'allow') return refuse(gate.kind, 403, req, requestId);
    }

    const headers = new Headers(req.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return withRequestId(NextResponse.next({ request: { headers } }), requestId);
}

export const config = {
    matcher: ['/api/:path*', '/w/:path*'],
};
