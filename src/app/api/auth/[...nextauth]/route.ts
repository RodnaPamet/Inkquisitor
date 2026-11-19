/**
 * The NextAuth v4 endpoints: /api/auth/csrf, /session, /providers, /signin,
 * /callback/*, /signout.
 *
 * Rate limits, three layers deep for a credential guess:
 *   - the edge auth tier (src/lib/rate-limit/authRateLimit.ts), per IP + UA;
 *   - here, `LOGIN_LIMIT` (10 per 15 minutes, then a 15-minute lockout) on the
 *     POSTs that carry a credential — the credentials callback and the sign-in
 *     starts — keyed on the IP (the body is NextAuth's to parse); every other
 *     POST (sign-out, a session update) gets the default mutation budget;
 *   - in `authenticateWithPassword`, the progressive per-email lockout.
 *
 * Adapted from inflect-compliance's route (see docs/carve-manifest.md).
 */
import type { NextRequest } from 'next/server';
import NextAuth from 'next-auth';
import { authOptions } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { carriesCredential } from '@/lib/auth/credential-post';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ nextauth: string[] }> };

const handler = NextAuth(authOptions) as (req: NextRequest, ctx: { params: { nextauth: string[] } }) => Promise<Response>;

async function delegate(req: NextRequest, ctx: RouteContext): Promise<Response> {
    const params = await ctx.params;
    return handler(req, { params });
}

const credentialPost = withApiErrorHandling<RouteContext>(delegate, { rateLimit: { config: LOGIN_LIMIT, scope: 'login' } });
const otherPost = withApiErrorHandling<RouteContext>(delegate);

export const GET = withApiErrorHandling<RouteContext>(delegate);

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
    const params = await ctx.params;
    const resolved: RouteContext = { params: Promise.resolve(params) };
    return carriesCredential(params.nextauth) ? credentialPost(req, resolved) : otherPost(req, resolved);
}
