/**
 * The edge's workspace access gate: which workspace a request names, and
 * whether the session's JWT claims a membership in it.
 *
 * `/w/<slug>/…` (pages) and `/api/w/<slug>/…` (API) require `<slug>` to be in
 * the JWT's `memberships[]`. A mismatch sends a page to `/no-workspace` and
 * answers an API request 403; no session at all sends a page to `/login` and
 * answers 401 (`src/middleware.ts`). The claim list is capped at
 * `MAX_JWT_MEMBERSHIPS`; when it was capped (`membershipsTruncated`), a slug
 * missing from it is deferred to the DB-backed server gate (`getWorkspaceCtx`,
 * the workspace layout) instead of denied.
 *
 * THE EDGE ONLY PRE-FILTERS. Every workspace route still resolves the
 * membership from the database before it touches data, and that check is the
 * authority. The edge decodes the cookie without running the `jwt` callback,
 * so a revoked session passes here and is refused there.
 *
 * ── WHICH SLUG ──────────────────────────────────────────────────────
 *
 * The same care as `src/lib/rate-limit/edge-tier.ts`: Next routes a dynamic
 * segment from the RAW path split on raw `/`, each param decoded on its own,
 * and runs the middleware when the raw or the decoded path matches. So the
 * gate collects the slug from EVERY spelling a route could read — the
 * per-segment decoded view, the fully decoded view (an encoded `%2F` becomes a
 * separator, `\` reads as `/`), and that view with `.`/`..` resolved — and
 * admits the request only when EVERY candidate is a slug the session holds.
 * `/w/mine/x%2F..%2F..%2Fw%2Ftheirs%2Fbooks` names `theirs` in one spelling,
 * so it is refused. The prefix match is case-insensitive (`/W/…`, `/%77/…`);
 * the slug match is exact, because slugs are stored lower-case and a route
 * looking up `Mine` finds nothing.
 *
 * Edge-safe and pure: no Next import, no Node import. Adapted from
 * inflect-compliance's `checkTenantAccess` in `src/lib/auth/guard.ts` (see
 * docs/carve-manifest.md).
 */
import type { WorkspaceRole } from '@/app-layer/types';

/** The JWT carries at most this many memberships, so the cookie stays bounded. */
export const MAX_JWT_MEMBERSHIPS = 50;

/** One workspace the session belongs to, as the JWT carries it. */
export interface MembershipClaim {
    slug: string;
    workspaceId: string;
    role: WorkspaceRole;
}

export interface WorkspaceGateTarget {
    /** `api` when any spelling is under `/api/w/`, so a refusal is JSON rather than a redirect. */
    kind: 'page' | 'api';
    /** Every slug a spelling of the path names (deduplicated). `''` when a spelling names `/w/` with no slug. */
    slugs: string[];
}

export type WorkspaceGateResult = 'allow' | 'no_workspace_access' | 'cross_workspace';

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
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

/** The segment lists a route could be matched by, original case. */
export function workspacePathSpellings(rawPathname: string): string[][] {
    const params = rawPathname.split('/').filter((s) => s !== '').map(decodeSegment);
    const decoded = params.join('/').replace(/\\/g, '/').split('/').filter((s) => s !== '');
    return [params, decoded, resolveDotSegments(decoded)];
}

/** The workspace a path names, or null when no spelling is a workspace path. */
export function workspaceGateTarget(rawPathname: string): WorkspaceGateTarget | null {
    let kind: WorkspaceGateTarget['kind'] | null = null;
    const slugs = new Set<string>();
    for (const segments of workspacePathSpellings(rawPathname)) {
        const [first, second, third] = segments;
        if (first?.toLowerCase() === 'w') {
            kind ??= 'page';
            slugs.add(second ?? '');
        } else if (first?.toLowerCase() === 'api' && second?.toLowerCase() === 'w') {
            kind = 'api';
            slugs.add(third ?? '');
        }
    }
    return kind ? { kind, slugs: [...slugs] } : null;
}

/** Whether the claims admit every slug the path names. */
export function checkWorkspaceAccess(
    slugs: readonly string[],
    memberships: readonly Pick<MembershipClaim, 'slug'>[] | null | undefined,
    membershipsTruncated = false,
): WorkspaceGateResult {
    // A truncated list is never empty, so an empty one means no membership at all.
    if (!memberships || memberships.length === 0) return 'no_workspace_access';
    const held = new Set(memberships.map((m) => m.slug));
    if (slugs.every((slug) => slug !== '' && held.has(slug))) return 'allow';
    // Not in a capped list: defer to the server gate rather than refuse a member.
    // An empty slug is never deferred: no workspace can be called that.
    if (membershipsTruncated && slugs.every((slug) => slug !== '')) return 'allow';
    return 'cross_workspace';
}
