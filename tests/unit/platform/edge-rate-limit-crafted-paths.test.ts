/**
 * Crafted requests cannot step around the edge rate-limit tiers.
 *
 * Next 16 runs the middleware when EITHER the raw or the percent-decoded
 * pathname matches `/api/:path*` (resolve-routes.js), and it routes a request
 * by its decoded path, so `/api/%61uth/…` reaches the `/api/auth/…` handler
 * while `req.nextUrl.pathname` still reads `%61uth`. A HEAD request runs a
 * route's GET handler. Each variant below is therefore a request a route
 * would answer; each must be charged to the SAME bucket as its canonical
 * form, which is what every test here asserts: exhaust the budget with the
 * variant, then the canonical request is refused (and vice versa).
 *
 * The opposite direction matters as much. Next matches a dynamic or
 * catch-all route on the RAW path split on raw `/`, decoding each param on its
 * own, so a `%2F..%2F` inside one segment is NOT traversal to Next: a
 * `/api/auth/[...nextauth]` catch-all answers
 * `/api/auth/callback/credentials/z%2F..%2F…%2Fapi%2Fhealth` as the
 * credentials callback. No spelling may therefore turn such a request into a
 * probe, a mutation, or another workspace's read.
 */
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { _clearAuthRateLimitMemory, AUTH_TIER_POLICIES } from '@/lib/rate-limit/authRateLimit';
import { _clearApiReadRateLimitMemory } from '@/lib/rate-limit/apiReadRateLimit';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';

function req(path: string, method = 'GET', headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'jest', ...headers },
    });
}

beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = '1';
    _clearAuthRateLimitMemory();
    _clearApiReadRateLimitMemory();
});
afterEach(() => {
    delete process.env.RATE_LIMIT_ENABLED;
});

const CANONICAL_SIGN_IN = '/api/auth/callback/credentials';

const SIGN_IN_VARIANTS: readonly string[] = [
    '/api/%61uth/callback/credentials', // percent-encoded letter
    '/%61pi/auth/callback/credentials', // percent-encoded first segment
    '/api/%61%75%74%68/callback/credentials',
    '/API/AUTH/callback/credentials', // case
    '/Api/Auth/Callback/Credentials',
    '/api/auth//callback/credentials', // duplicate slash
    '//api/auth/callback/credentials',
    '/api/auth/callback/credentials/', // trailing slash
    '/api/./auth/callback/credentials', // dot segments
    '/api/%2e/auth/callback/credentials',
    '/api/x/%2e%2e/auth/callback/credentials',
    '/api/auth%2Fcallback%2Fcredentials', // encoded separator
    '/api/auth/%63allback/credentials', // encoded letter inside the high-tier prefix
];

describe('the auth tier cannot be skipped by spelling the path differently', () => {
    it.each(SIGN_IN_VARIANTS)('%s is charged to the sign-in bucket', async (variant) => {
        const limit = AUTH_TIER_POLICIES.high.limit;
        for (let i = 0; i < limit; i++) {
            expect((await middleware(req(variant, 'POST'))).status).toBe(200);
        }
        // The variant is refused, and so is the canonical path: one bucket.
        expect((await middleware(req(variant, 'POST'))).status).toBe(429);
        expect((await middleware(req(CANONICAL_SIGN_IN, 'POST'))).status).toBe(429);
    });

    it('the canonical path spends the budget a variant would use', async () => {
        for (let i = 0; i < AUTH_TIER_POLICIES.high.limit; i++) {
            await middleware(req(CANONICAL_SIGN_IN, 'POST'));
        }
        for (const variant of SIGN_IN_VARIANTS) {
            expect([variant, (await middleware(req(variant, 'POST'))).status]).toEqual([variant, 429]);
        }
    });

    it('every method on an auth path is in the auth tier, HEAD and GET alike', async () => {
        const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
        for (let i = 0; i < AUTH_TIER_POLICIES.high.limit; i++) {
            await middleware(req('/api/auth/signin', methods[i % methods.length]));
        }
        expect((await middleware(req('/api/auth/signin', 'HEAD'))).status).toBe(429);
    });

    it('a header that names a middleware subrequest changes nothing', async () => {
        const spoof = { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' };
        for (let i = 0; i < AUTH_TIER_POLICIES.high.limit; i++) {
            await middleware(req(CANONICAL_SIGN_IN, 'POST', spoof));
        }
        expect((await middleware(req(CANONICAL_SIGN_IN, 'POST', spoof))).status).toBe(429);
    });

    it('an encoded session probe is charged to the session bucket, not the looser one', async () => {
        for (let i = 0; i < AUTH_TIER_POLICIES.medium.limit; i++) {
            expect((await middleware(req('/api/%61uth/session'))).status).toBe(200);
        }
        expect((await middleware(req('/api/auth/session'))).status).toBe(429);
    });
});

describe('the read tier cannot be skipped', () => {
    async function exhaust(path: string, method = 'GET') {
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            expect((await middleware(req(path, method))).status).toBe(200);
        }
    }

    it('HEAD runs the GET handler, so it is a read', async () => {
        await exhaust('/api/books', 'HEAD');
        expect((await middleware(req('/api/books', 'HEAD'))).status).toBe(429);
        expect((await middleware(req('/api/books'))).status).toBe(429);
    });

    it.each(['/%61pi/books', '/API/books', '//api/books', '/api/books/', '/api/./books', '/api%2Fbooks'])(
        '%s is charged to the same bucket as /api/books',
        async (variant) => {
            await exhaust(variant);
            expect((await middleware(req('/api/books'))).status).toBe(429);
        },
    );

    it('an unrecognised method is a read, not a pass', async () => {
        await exhaust('/api/books', 'OPTIONS');
        expect((await middleware(req('/api/books', 'PROPFIND'))).status).toBe(429);
    });

    it.each(['/api/w/%61/things', '/api/w/A/things', '/api//w/a/things', '/api/w/a/./things'])(
        '%s spends workspace a’s budget, not a fresh one',
        async (variant) => {
            await exhaust(variant);
            expect((await middleware(req('/api/w/a/things'))).status).toBe(429);
            expect((await middleware(req('/api/w/b/things'))).status).toBe(200);
        },
    );

    it('a path that only looks like a probe is still limited', async () => {
        await exhaust('/api/healthcheck');
        expect((await middleware(req('/api/%68ealthcheck'))).status).toBe(429);
        expect((await middleware(req('/api/health.json'))).status).toBe(429);
    });
});

describe('encoded traversal inside a segment cannot leave a counted tier', () => {
    const ENCODED_TRAVERSAL_TO_PROBE = '/api/auth/callback/credentials/z%2F..%2F..%2F..%2F..%2F..%2Fapi%2Fhealth';

    it('a sign-in that resolves to a probe is charged to the sign-in bucket', async () => {
        for (let i = 0; i < AUTH_TIER_POLICIES.high.limit; i++) {
            expect((await middleware(req(ENCODED_TRAVERSAL_TO_PROBE, 'POST'))).status).toBe(200);
        }
        expect((await middleware(req(ENCODED_TRAVERSAL_TO_PROBE, 'POST'))).status).toBe(429);
        expect((await middleware(req(CANONICAL_SIGN_IN, 'POST'))).status).toBe(429);
    });

    it('a sign-in that resolves out of /api/auth stays in the auth tier, not the mutation tier', async () => {
        const escapesToWorkspace = '/api/auth/signin/x%2F..%2F..%2F..%2Fw%2Fa';
        for (let i = 0; i < AUTH_TIER_POLICIES.high.limit; i++) {
            expect((await middleware(req(escapesToWorkspace, 'POST'))).status).toBe(200);
        }
        expect((await middleware(req(escapesToWorkspace, 'POST'))).status).toBe(429);
        expect((await middleware(req('/api/auth/signin', 'POST'))).status).toBe(429);
    });

    it('a session probe spelled to resolve to a looser endpoint keeps its stricter budget', async () => {
        const looksLikeCsrf = '/api/auth/session/..%2Fcsrf';
        for (let i = 0; i < AUTH_TIER_POLICIES.medium.limit; i++) {
            expect((await middleware(req(looksLikeCsrf))).status).toBe(200);
        }
        expect((await middleware(req(looksLikeCsrf))).status).toBe(429);
        expect((await middleware(req('/api/auth/session'))).status).toBe(429);
    });

    it('a workspace read that resolves to a probe is charged to that workspace', async () => {
        const toProbe = '/api/w/acme/docs/x%2F..%2F..%2F..%2F..%2F..%2Fapi%2Fhealth';
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            expect((await middleware(req(toProbe))).status).toBe(200);
        }
        expect((await middleware(req(toProbe))).status).toBe(429);
        expect((await middleware(req('/api/w/acme/docs'))).status).toBe(429);
        // The probe itself is untouched, and so is another workspace.
        expect((await middleware(req('/api/health'))).status).toBe(200);
        expect((await middleware(req('/api/w/other/docs'))).status).toBe(200);
    });

    it('a workspace read cannot move itself into another workspace’s bucket', async () => {
        const hops = '/api/w/acme/docs/x%2F..%2F..%2F..%2Fw%2Fother';
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            expect((await middleware(req(hops))).status).toBe(200);
        }
        expect((await middleware(req('/api/w/acme/docs'))).status).toBe(429);
        expect((await middleware(req('/api/w/other/docs'))).status).toBe(200);
    });

    it.each(['/api/%68ealth', '/API/livez', '/api/health/x%2F..', '/api/books/..%2Fhealth', '/api/health%2F'])(
        '%s is not a canonical probe, so it is counted',
        async (spelling) => {
            for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) await middleware(req('/api/books'));
            expect((await middleware(req(spelling))).status).toBe(429);
        },
    );
});

describe('the probes stay unlimited when spelled as a monitor spells them', () => {
    it.each(['/api/health', '/api/livez', '/api/readyz', '/api/readyz/', '//api/readyz'])(
        '%s answers with the non-workspace bucket exhausted',
        async (probe) => {
            for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) await middleware(req('/api/books'));
            expect((await middleware(req('/api/books'))).status).toBe(429);
            expect((await middleware(req(probe))).status).toBe(200);
            expect((await middleware(req(probe, 'HEAD'))).status).toBe(200);
        },
    );
});
