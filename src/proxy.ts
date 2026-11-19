/**
 * The proxy (Next 16's name for middleware; it runs on the Node.js runtime) —
 * the auth and read rate-limit tiers, the workspace access gate, the request
 * id and the security headers. In that order.
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
 *      Workspace PAGES are not charged: the read tier budgets API reads. The
 *      client address every tier keys on is the X-Forwarded-For entry
 *      `TRUSTED_PROXY_HOPS` from the right (src/lib/http/client-ip.ts).
 *
 *   2. THE WORKSPACE GATE (Phase 0.3). A request any spelling of whose path
 *      names `/w/<slug>/…` or `/api/w/<slug>/…` (`workspaceGateTarget`) needs a
 *      session whose JWT claims a membership in every slug named
 *      (`checkWorkspaceAccess`, src/lib/auth/workspace-gate.ts):
 *        no session        page → /login?callbackUrl=…   API → 401
 *        no membership     page → /no-workspace          API → 403
 *        not this slug     page → /no-workspace          API → 403
 *      The proxy reads the JWT claim only — no database. It is a pre-filter:
 *      the route's own `getWorkspaceCtx` re-checks the membership in the
 *      database, and the `jwt` callback (which the proxy does not run) refuses
 *      a revoked session there. A capped claim list defers a miss to that
 *      server check.
 *
 *   3. Every response carries `x-request-id`: the caller's own when it has the
 *      safe shape, a new UUID otherwise, forwarded to the handler and named in
 *      every rate-limit log line (issue #7).
 *
 *   4. Every response carries the content-security policy, with a fresh nonce,
 *      and the security headers (src/lib/security/csp.ts) — the proxy's own
 *      refusals and redirects as well as the routes' answers (Phase 0.H). The
 *      policy and the nonce are also set on the forwarded REQUEST: Next reads
 *      the policy there to stamp its own scripts, and the root layout reads
 *      the nonce for the two inline scripts it renders.
 *
 * The matcher is every path except the static assets, which next.config.mjs
 * gives the same headers: the two are a PARTITION of every path (each path is
 * stamped by exactly one of them), held by tests/unit/platform/proxy-matcher.test.ts.
 *
 * THE GRAPH STAYS RUNTIME-NEUTRAL. Next 16 runs the proxy on Node, but nothing
 * it imports needs Node: Web Crypto, `fetch`-only Upstash, the console logger.
 * `tests/guards/proxy-imports-no-node-only-module.test.ts` walks its import
 * graph, and `scripts/check-build.mjs` reads the bundle the build produces.
 *
 * Shape follows inflect-compliance's `src/middleware.ts` (see
 * docs/carve-manifest.md), cut to these tiers and one gate.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { classifyEdgeRequest, edgePathSpellings, enforceEdgeRateLimit } from '@/lib/rate-limit/edge-tier';
import { authSecret } from '@/lib/auth/auth-secret';
import { checkWorkspaceAccess, workspaceGateTarget } from '@/lib/auth/workspace-gate';
import { CSP_HEADER, CSP_NONCE_HEADER, applySecurityHeaders, buildCspHeader, generateNonce } from '@/lib/security/csp';
import { env } from '@/env';

const REQUEST_ID_HEADER = 'x-request-id';
/** A caller-supplied id is accepted only in this shape, so a header cannot inject into a log line. */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdFor(req: NextRequest): string {
    const offered = req.headers.get(REQUEST_ID_HEADER);
    return offered && REQUEST_ID_SHAPE.test(offered) ? offered : crypto.randomUUID();
}

/** What every response of one request carries: its id and the security headers. */
interface ResponseStamp {
    requestId: string;
    csp: string;
}

function stamp(res: NextResponse, s: ResponseStamp): NextResponse {
    res.headers.set(REQUEST_ID_HEADER, s.requestId);
    applySecurityHeaders(res.headers, s.csp, env.NODE_ENV === 'production');
    return res;
}

/** True when any spelling Next could route the path by is under `/api`. */
export function isApiPath(rawPathname: string): boolean {
    const spelt = edgePathSpellings(rawPathname);
    return [spelt.raw, spelt.decoded, spelt.resolved].some((p) => p === '/api' || p.startsWith('/api/'));
}

function refuse(kind: 'page' | 'api', status: 401 | 403, req: NextRequest, s: ResponseStamp): NextResponse {
    if (kind === 'api') {
        const code = status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
        const message = status === 401 ? 'Sign in to continue.' : 'You do not have access to this workspace.';
        return stamp(NextResponse.json({ error: { code, message, requestId: s.requestId } }, { status }), s);
    }
    const url = req.nextUrl.clone();
    if (status === 401) {
        url.pathname = '/login';
        url.search = `?callbackUrl=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    } else {
        url.pathname = '/no-workspace';
        url.search = '';
    }
    return stamp(NextResponse.redirect(url), s);
}

async function readToken(req: NextRequest) {
    try {
        return await getToken({ req, secret: authSecret() });
    } catch {
        // An unreadable cookie is no session.
        return null;
    }
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
    const requestId = requestIdFor(req);
    const nonce = generateNonce();
    const s: ResponseStamp = { requestId, csp: buildCspHeader(nonce, env.NODE_ENV === 'development') };
    const pathname = req.nextUrl.pathname;
    const gate = workspaceGateTarget(pathname);
    const api = isApiPath(pathname);
    const token = gate || api ? await readToken(req) : null;
    const userId = typeof token?.userId === 'string' ? token.userId : null;

    if (api) {
        const tier = classifyEdgeRequest(req.method, pathname);
        const verdict = await enforceEdgeRateLimit(req, tier, { userId, requestId });
        if (!verdict.ok) return stamp(verdict.response, s);
    }

    if (gate) {
        if (!userId) return refuse(gate.kind, 401, req, s);
        const verdict = checkWorkspaceAccess(gate.slugs, token?.memberships, token?.membershipsTruncated === true);
        if (verdict !== 'allow') return refuse(gate.kind, 403, req, s);
    }

    const headers = new Headers(req.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    headers.set(CSP_NONCE_HEADER, nonce);
    headers.set(CSP_HEADER, s.csp);
    return stamp(NextResponse.next({ request: { headers } }), s);
}

/**
 * Every path except the static assets (next.config.mjs stamps those): pages,
 * API routes, the 404 page, the probes. A path the proxy does not run for
 * would answer without a policy.
 *
 * The exclusion is anchored at a segment boundary. It used to be
 * `(?!_next/static|_next/image)`, a bare prefix, so `/_next/imagefoo`,
 * `/_next/image_`, `/_next/static-x` and `/_next/staticx/a` skipped the proxy
 * and rendered the 404 page with no policy, no headers and un-nonced scripts.
 * Now only a path INSIDE `/_next/static/` (at least one character after the
 * slash) and the image optimiser's own path, exactly `/_next/image` (its
 * input is the query string, which the matcher never sees), are skipped —
 * the two sources `headers()` in next.config.mjs stamps instead.
 */
export const config = {
    matcher: ['/((?!_next/static/.|_next/image$).*)'],
};
