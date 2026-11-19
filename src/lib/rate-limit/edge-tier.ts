/**
 * Which edge rate-limit tier a request is charged to, and the one call that
 * charges it.
 *
 * ── WHY NOT THE RAW PATH, AND WHY NOT ONE NORMALISED PATH EITHER ─────
 *
 * The edge used to ask two predicates of the RAW `req.nextUrl.pathname`
 * (`isAuthRateLimited`, `isApiReadRateLimited`) and call a limiter only when
 * one said yes. The raw path is not the path Next routes:
 *
 *   - Next 16 runs the proxy when the raw OR the percent-decoded path
 *     matches `/api/:path*`, and matches static routes on the decoded path, so
 *     `/api/%61uth/callback/x` and `/%61pi/auth/…` reach the `/api/auth`
 *     handlers while `pathname` still reads `%61uth` — and escaped both tiers.
 *   - A HEAD request runs a route's GET handler, and the read tier asked
 *     `method !== 'GET'`, so every read could be repeated as a HEAD unlimited.
 *   - `//api/…` and an encoded `%2F` spell the same route in a form a
 *     `startsWith('/api/')` check does not recognise.
 *
 * Replacing the raw path with ONE normalised path (decode, then resolve `..`)
 * opened the opposite hole, because Next does not route that way either. A
 * dynamic or catch-all route is matched on the RAW pathname split on raw `/`,
 * each param decoded on its own (`route-matcher.js`:
 * `match.split('/').map(decode)`), and a static route is compared with the
 * decoded path with no `..` resolution. So
 * `POST /api/auth/callback/credentials/z%2F..%2F..%2F..%2F..%2F..%2Fapi%2Fhealth`
 * normalises to `/api/health` while a `/api/auth/[...nextauth]` catch-all
 * would answer it as the credentials callback: classified by the normalised
 * path alone it was exempt, i.e. unlimited credential guessing.
 *
 * The rule is therefore asymmetric, because the two mistakes are not:
 *
 *   COUNTED tiers over-cover. A request is in the auth tier when ANY spelling
 *   Next could route it by is at or below `/api/auth`: the raw path, the path
 *   decoded once (no dot resolution), or the decoded path with `.`/`..`
 *   resolved (`edgePathSpellings`), all lowercased for comparison. Its level
 *   is the STRICTEST any of those spellings names, so a looser-looking
 *   spelling never buys a looser budget. Charging a request that turns out
 *   not to be an auth route costs nothing that matters.
 *
 *   The EXEMPTION under-covers. Only a request that cannot be routed to
 *   anything but a probe is waved through (`isCanonicalProbe`): the raw path,
 *   with empty segments dropped, equals the probe exactly — no `%`, no `\`,
 *   no dot segment, same case. Any other spelling of a probe is counted as a
 *   read, which a monitor never sends and an attacker gains nothing from.
 *
 * Every request gets a tier, and the proxy calls `enforceEdgeRateLimit`
 * for every request, unconditionally, with the tier as an argument: no
 * condition on the request decides whether a limiter runs, only which budget
 * it counts against.
 *
 * ── THE TIERS, IN PRECEDENCE ORDER ───────────────────────────────────
 *
 *   auth      any spelling at or below /api/auth, ANY method  (authRateLimit.ts)
 *   exempt    a canonically spelled probe, ANY method          (nothing — they must answer during an attack)
 *   mutation  POST / PUT / PATCH / DELETE elsewhere            (charged in the route by
 *             withApiErrorHandling's API_MUTATION_LIMIT; nothing at the edge)
 *   read      every other request: GET, HEAD (which runs the GET handler),
 *             OPTIONS and any method not named above           (apiReadRateLimit.ts)
 *
 * The auth tier wins over both `exempt` and `mutation`: a request one
 * spelling puts below `/api/auth` is charged there whatever another spelling
 * says. `read` is the fall-through on purpose: a method or path nobody listed
 * is counted, never waved through.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { checkAuthRateLimit, classifyAuthEndpoint, type AuthEndpointTier } from './authRateLimit';
import { checkApiReadRateLimit } from './apiReadRateLimit';

/**
 * The probes: they must answer during an attack. Exempt only when spelled
 * exactly (`isCanonicalProbe`); `/api/healthcheck` is not a probe and
 * `/api/%68ealth` is counted. (inflect-compliance also exempts its OpenAPI
 * `/api/docs`; Inkquisitor ships no such route, so it is not exempt here — add
 * a path only with the route it serves.)
 */
export const RATE_LIMIT_EXEMPT_PATHS: readonly string[] = ['/api/health', '/api/livez', '/api/readyz'];

/** The auth tier's root; a request any spelling puts at or below it is the auth tier. */
export const AUTH_TIER_ROOT = '/api/auth';

/** Methods whose budget is charged in the route handler, not here. */
const HANDLER_LIMITED_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Strictest first: the order the auth level is chosen in when spellings disagree. */
const AUTH_LEVELS_STRICTEST_FIRST: readonly AuthEndpointTier[] = ['high', 'medium', 'low'];

export type EdgeTier =
    | { kind: 'auth'; level: AuthEndpointTier; path: string }
    | { kind: 'read'; workspaceSlug: string | null; path: string }
    | { kind: 'mutation'; path: string }
    | { kind: 'exempt'; path: string };

export type EdgeTierKind = EdgeTier['kind'];

export type EdgeVerdict = { ok: true } | { ok: false; response: NextResponse };

/**
 * The spellings Next could route one request by. Every string form is
 * lowercased (for comparison only), begins with `/`, has `\` read as `/` and
 * empty segments dropped.
 *
 *   raw       not decoded at all. Also the form that is logged: the URL parser
 *             has already percent-encoded anything that could break a line.
 *   decoded   each raw segment decoded once, on its own (a segment that does
 *             not decode stays raw); an encoded `%2F` becomes a separator and
 *             `..` stays a literal segment — the static-route view.
 *   resolved  `decoded` with `.` and `..` segments resolved.
 *   segments  the decoded raw segments, split on raw `/` only, original case —
 *             what a dynamic route's params are read from.
 */
export interface EdgePathSpellings {
    raw: string;
    decoded: string;
    resolved: string;
    segments: readonly string[];
}

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        // Malformed escape: Next refuses to decode it too; keep the raw form.
        return segment;
    }
}

function splitPath(path: string): string[] {
    return path.replace(/\\/g, '/').split('/').filter((s) => s !== '');
}

function resolveDotSegments(segments: readonly string[]): string[] {
    const out: string[] = [];
    for (const segment of segments) {
        if (segment === '.') continue;
        if (segment === '..') {
            out.pop();
            continue;
        }
        out.push(segment);
    }
    return out;
}

const asPath = (segments: readonly string[]) => `/${segments.join('/')}`.toLowerCase();

export function edgePathSpellings(rawPathname: string): EdgePathSpellings {
    const rawSegments = rawPathname.split('/').filter((s) => s !== '');
    const segments = rawSegments.map(decodeSegment);
    const decodedSegments = splitPath(segments.join('/'));
    return {
        raw: asPath(splitPath(rawPathname)),
        decoded: asPath(decodedSegments),
        resolved: asPath(resolveDotSegments(decodedSegments)),
        segments,
    };
}

function isAtOrBelow(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

/**
 * True only when the request cannot be routed to anything but `probe`: the
 * raw path carries no escape, no backslash and no dot segment, and its
 * non-empty segments are exactly the probe's, case included. Deliberately
 * narrow — this is the one answer that switches counting off.
 */
export function isCanonicalProbe(rawPathname: string, probe: string): boolean {
    if (rawPathname.includes('%') || rawPathname.includes('\\')) return false;
    const segments = rawPathname.split('/').filter((s) => s !== '');
    if (segments.some((s) => s === '.' || s === '..')) return false;
    return `/${segments.join('/')}` === probe;
}

/**
 * The workspace slug of an `/api/w/<slug>/…` request, read the way a
 * `/api/w/[slug]` route reads its param: from the decoded RAW segments, so a
 * `%2F..%2F` inside a later segment cannot move it. Lowercased, so
 * `/api/w/A/…` and `/api/w/%61/…` spend workspace `a`'s budget.
 */
export function workspaceSlugOf(segments: readonly string[]): string | null {
    const [api, w, slug] = segments;
    if (api?.toLowerCase() !== 'api' || w?.toLowerCase() !== 'w' || !slug) return null;
    return slug.toLowerCase();
}

/** The tier a request is charged to. Total: every method and path has one. */
export function classifyEdgeRequest(method: string, rawPathname: string): EdgeTier {
    const spelt = edgePathSpellings(rawPathname);
    // Every spelling is judged, and its level computed, whatever it says: the
    // request decides what the answers are used for, never whether they run.
    const judged = [spelt.raw, spelt.decoded, spelt.resolved].map((path) => ({
        inAuthTier: isAtOrBelow(path, AUTH_TIER_ROOT),
        level: classifyAuthEndpoint(path),
    }));
    const authLevels = new Set(judged.filter((j) => j.inAuthTier).map((j) => j.level));
    const level = AUTH_LEVELS_STRICTEST_FIRST.find((l) => authLevels.has(l));
    if (level) return { kind: 'auth', level, path: spelt.raw };
    if (RATE_LIMIT_EXEMPT_PATHS.some((probe) => isCanonicalProbe(rawPathname, probe))) {
        return { kind: 'exempt', path: spelt.raw };
    }
    if (HANDLER_LIMITED_METHODS.has(method.toUpperCase())) return { kind: 'mutation', path: spelt.raw };
    return { kind: 'read', workspaceSlug: workspaceSlugOf(spelt.segments), path: spelt.raw };
}

type TierOf<K extends EdgeTierKind> = Extract<EdgeTier, { kind: K }>;

/** Who is asking: the signed-in user (keys the read tier) and the proxy's request id (every log line). */
export interface EdgeCaller {
    userId: string | null;
    requestId: string;
}

type Limiter<K extends EdgeTierKind> = (req: NextRequest, tier: TierOf<K>, caller: EdgeCaller) => Promise<EdgeVerdict>;

const ALLOWED: EdgeVerdict = { ok: true };

/** One limiter per tier, chosen by lookup rather than by a branch. */
const LIMITERS: { readonly [K in EdgeTierKind]: Limiter<K> } = {
    auth: async (req, tier, caller) => {
        const rl = await checkAuthRateLimit(req, tier.level, tier.path, caller.requestId);
        return rl.ok || !rl.response ? ALLOWED : { ok: false, response: rl.response };
    },
    read: async (req, tier, caller) => {
        const rl = await checkApiReadRateLimit(req, tier.workspaceSlug, caller.userId, caller.requestId);
        return rl.ok || !rl.response ? ALLOWED : { ok: false, response: rl.response };
    },
    // Charged by withApiErrorHandling inside the route (API_MUTATION_LIMIT).
    mutation: async () => ALLOWED,
    // The probes must answer during an attack.
    exempt: async () => ALLOWED,
};

function chargeTo<K extends EdgeTierKind>(req: NextRequest, tier: TierOf<K> & { kind: K }, caller: EdgeCaller) {
    const limiter: Limiter<K> = LIMITERS[tier.kind];
    return limiter(req, tier, caller);
}

/**
 * Charge a request to its tier. The proxy calls this for every request; the
 * tier, never a condition around the call, decides the budget. The caller's
 * request id is the one the proxy stamps on the response, so a tier's log
 * line names the request the client was answered for (issue #7: it used to
 * read "unknown").
 */
export function enforceEdgeRateLimit(req: NextRequest, tier: EdgeTier, caller: EdgeCaller): Promise<EdgeVerdict> {
    return chargeTo(req, tier, caller);
}
