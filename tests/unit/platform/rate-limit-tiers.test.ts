/**
 * The three rate-limit tiers and their storage.
 *
 *   auth tier   /api/auth/**  at the edge, keyed on the client address alone, 10/30/60 per min
 *   read tier   GET/HEAD/…    at the edge, keyed (workspace, IP, user), 120/min
 *               (crafted spellings of both: edge-rate-limit-crafted-paths.test.ts)
 *   mutation    in the route  (covered in api-error-handling.test.ts)
 *
 * Storage is in-memory unless both Upstash variables are set; no test here
 * configures Upstash, so none reaches the network.
 */
// These suites measure the rate-limit tiers, not the workspace gate (its own
// suite is tests/unit/auth/proxy-workspace-gate.test.ts): every request
// carries a session whose capped claim list defers any slug to the server.
jest.mock('next-auth/jwt', () => ({
    getToken: jest.fn(async () => ({ userId: 'user_rl', memberships: [{ slug: '_', workspaceId: 'ws_', role: 'OWNER' }], membershipsTruncated: true })),
}));

import { NextRequest } from 'next/server';
import { proxy, requestIdFor } from '@/proxy';
import { _clearAuthRateLimitMemory, classifyAuthEndpoint, AUTH_TIER_POLICIES } from '@/lib/rate-limit/authRateLimit';
import { _clearApiReadRateLimitMemory, buildReadKey } from '@/lib/rate-limit/apiReadRateLimit';
import {
    RATE_LIMIT_EXEMPT_PATHS,
    classifyEdgeRequest,
    edgePathSpellings,
    isCanonicalProbe,
    workspaceSlugOf,
} from '@/lib/rate-limit/edge-tier';
import { MemoryWindowStore, usesUpstash } from '@/lib/rate-limit/window-store';
import { API_READ_LIMIT, checkRateLimit, clearAllRateLimits, rateLimitKeyCount } from '@/lib/security/rate-limit';

function req(path: string, method = 'GET', ip = '203.0.113.7') {
    return new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-forwarded-for': ip, 'user-agent': 'jest' },
    });
}

beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = '1';
    _clearAuthRateLimitMemory();
    _clearApiReadRateLimitMemory();
});
afterEach(() => {
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.RATE_LIMIT_MODE;
});

describe('storage choice', () => {
    it('uses memory unless BOTH Upstash variables are set', () => {
        expect(usesUpstash()).toBe(false);
        process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
        expect(usesUpstash()).toBe(false);
        process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
        expect(usesUpstash()).toBe(true);
        process.env.RATE_LIMIT_MODE = 'memory';
        expect(usesUpstash()).toBe(false);
    });
});

describe('MemoryWindowStore', () => {
    it('counts a fixed window and resets after it', () => {
        let now = 1_000_000;
        const store = new MemoryWindowStore(() => now);
        const policy = { limit: 2, windowMs: 10_000 };
        expect(store.check('k', policy).ok).toBe(true);
        expect(store.check('k', policy).ok).toBe(true);
        const blocked = store.check('k', policy);
        expect(blocked.ok).toBe(false);
        expect(blocked.retryAfter).toBe(10);
        now += 10_000;
        expect(store.check('k', policy).ok).toBe(true);
    });

    it('sweeps expired windows lazily, on a later call, with no timer', () => {
        let now = 0;
        const store = new MemoryWindowStore(() => now);
        for (let i = 0; i < 50; i++) store.check(`k${i}`, { limit: 1, windowMs: 1_000 });
        expect(store.size).toBe(50);
        now = 120_000; // past every window and past the sweep interval
        store.check('fresh', { limit: 1, windowMs: 1_000 });
        expect(store.size).toBe(1);
    });
});

describe('the in-process sliding window (mutation tier)', () => {
    beforeEach(() => clearAllRateLimits());

    it('refuses past the budget and charges all-or-nothing', () => {
        const cfg = { maxAttempts: 3, windowMs: 60_000 };
        expect(checkRateLimit('a', cfg, 2).allowed).toBe(true);
        const refused = checkRateLimit('a', cfg, 2);
        expect(refused.allowed).toBe(false);
        expect(refused.remaining).toBe(1);
        expect(checkRateLimit('a', cfg, 1).allowed).toBe(true);
    });

    it('sweeps stale keys on a caller turn (no setInterval)', () => {
        const realNow = Date.now;
        try {
            let now = 10_000_000;
            Date.now = () => now;
            for (let i = 0; i < 20; i++) checkRateLimit(`stale${i}`, { maxAttempts: 5, windowMs: 1_000 });
            expect(rateLimitKeyCount()).toBe(20);
            now += 10 * 60 * 1000;
            checkRateLimit('fresh', { maxAttempts: 5, windowMs: 1_000 });
            expect(rateLimitKeyCount()).toBe(1);
        } finally {
            Date.now = realNow;
        }
    });
});

describe('auth tier', () => {
    it('classifies credential endpoints as the strictest tier', () => {
        expect(classifyAuthEndpoint('/api/auth/callback/credentials')).toBe('high');
        expect(classifyAuthEndpoint('/api/auth/session')).toBe('medium');
        expect(classifyAuthEndpoint('/api/auth/csrf')).toBe('low');
    });

    it('blocks the 11th sign-in attempt in a minute from one client, with a request id', async () => {
        const limit = AUTH_TIER_POLICIES.high.limit;
        for (let i = 0; i < limit; i++) {
            expect((await proxy(req('/api/auth/callback/credentials', 'POST'))).status).toBe(200);
        }
        const blocked = await proxy(req('/api/auth/callback/credentials', 'POST'));
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('Retry-After')).toBeTruthy();
        expect(blocked.headers.get('x-request-id')).toBeTruthy();
        const body = await blocked.json();
        expect(JSON.stringify(body)).not.toContain('203.0.113.7');
        // A different client is unaffected.
        expect((await proxy(req('/api/auth/callback/credentials', 'POST', '198.51.100.1'))).status).toBe(200);
    });

    it('is off when RATE_LIMIT_ENABLED=0', async () => {
        process.env.RATE_LIMIT_ENABLED = '0';
        for (let i = 0; i < 30; i++) {
            expect((await proxy(req('/api/auth/signin', 'POST'))).status).toBe(200);
        }
    });
});

describe('the edge classifier', () => {
    const kind = (method: string, path: string) => classifyEdgeRequest(method, path).kind;

    it('gives every request a tier: reads, mutations, the auth tier and the probes', () => {
        expect(kind('GET', '/api/w/my-book/bible')).toBe('read');
        expect(kind('GET', '/api/books')).toBe('read');
        expect(kind('HEAD', '/api/books')).toBe('read');
        expect(kind('OPTIONS', '/api/books')).toBe('read');
        expect(kind('PROPFIND', '/api/books')).toBe('read');
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'patch']) expect(kind(m, '/api/books')).toBe('mutation');
        for (const m of ['GET', 'HEAD', 'POST']) expect(kind(m, '/api/auth/session')).toBe('auth');
        for (const p of ['/api/health', '/api/livez', '/api/readyz']) {
            expect(kind('GET', p)).toBe('exempt');
            expect(kind('HEAD', p)).toBe('exempt');
        }
        expect(kind('GET', '/api/healthcheck')).toBe('read');
        expect(kind('GET', '/api/authx')).toBe('read');
        // No route is exempt for a page Inkquisitor does not ship.
        expect(kind('GET', '/api/docs')).toBe('read');
        expect(RATE_LIMIT_EXEMPT_PATHS).toEqual(['/api/health', '/api/livez', '/api/readyz']);
    });

    it('picks the STRICTEST auth level any spelling names', () => {
        expect(classifyEdgeRequest('POST', '/api/%61uth/callback/credentials')).toMatchObject({ kind: 'auth', level: 'high' });
        expect(classifyEdgeRequest('GET', '/API/Auth/Session')).toMatchObject({ kind: 'auth', level: 'medium' });
        expect(classifyEdgeRequest('GET', '/api/auth/csrf')).toMatchObject({ kind: 'auth', level: 'low' });
        // Raw says csrf (low), resolved says callback (high): high.
        expect(classifyEdgeRequest('POST', '/api/auth/csrf/..%2Fcallback/credentials')).toMatchObject({ kind: 'auth', level: 'high' });
        // Raw says callback (high), resolved says csrf (low): still high.
        expect(classifyEdgeRequest('POST', '/api/auth/callback/..%2Fcsrf')).toMatchObject({ kind: 'auth', level: 'high' });
    });

    it('spells a path every way Next could route it, without resolving `..` inside a segment', () => {
        const crafted = edgePathSpellings('/api/auth/callback/credentials/z%2F..%2F..%2F..%2F..%2F..%2Fapi%2Fhealth');
        // The dynamic-route view: split on raw `/`, each segment decoded on its own.
        expect(crafted.segments).toEqual(['api', 'auth', 'callback', 'credentials', 'z/../../../../../api/health']);
        expect(crafted.raw).toBe('/api/auth/callback/credentials/z%2f..%2f..%2f..%2f..%2f..%2fapi%2fhealth');
        // The static-route view: decoded, `..` kept.
        expect(crafted.decoded).toBe('/api/auth/callback/credentials/z/../../../../../api/health');
        // Resolved is only one spelling among three, never the deciding one.
        expect(crafted.resolved).toBe('/api/health');

        expect(edgePathSpellings('//api///auth/./x/')).toMatchObject({ raw: '/api/auth/./x', resolved: '/api/auth/x' });
        expect(edgePathSpellings('/api\\auth').decoded).toBe('/api/auth');
        expect(edgePathSpellings('/API/Auth').decoded).toBe('/api/auth');
        // Decoded exactly once, as Next decodes it.
        expect(edgePathSpellings('/api/%2561uth').decoded).toBe('/api/%61uth');
        // A segment that does not decode stays raw; the others still decode.
        expect(edgePathSpellings('/api/%61uth/%E0%A4%A').decoded).toBe('/api/auth/%e0%a4%a');
        expect(classifyEdgeRequest('GET', '/api/%61uth/%E0%A4%A').kind).toBe('auth');
        expect(edgePathSpellings('/../..').resolved).toBe('/');
    });

    it('exempts only a probe spelled exactly', () => {
        for (const probe of ['/api/health', '/api/readyz/', '//api//livez']) {
            expect([probe, kind('GET', probe)]).toEqual([probe, 'exempt']);
        }
        for (const notQuite of [
            '/api/%68ealth',
            '/API/livez',
            '/api/x/%2e%2e/health',
            '/api/./health',
            '/api\\health',
            '/api/w/acme/docs/x%2F..%2F..%2F..%2F..%2F..%2Fapi%2Fhealth',
        ]) {
            expect([notQuite, kind('GET', notQuite)]).toEqual([notQuite, 'read']);
        }
        expect(isCanonicalProbe('/api/health', '/api/health')).toBe(true);
        expect(isCanonicalProbe('/api/health/x', '/api/health')).toBe(false);
        expect(isCanonicalProbe('/api/x/../health', '/api/health')).toBe(false);
    });

    it('lets no spelling move a request out of the auth tier', () => {
        // Each of these resolves to somewhere else; a catch-all under
        // /api/auth would still answer it. The auth tier wins over both
        // `exempt` and `mutation`.
        expect(classifyEdgeRequest('POST', '/api/auth/callback/credentials/z%2F..%2F..%2F..%2F..%2F..%2Fapi%2Fhealth')).toMatchObject({
            kind: 'auth',
            level: 'high',
        });
        expect(classifyEdgeRequest('POST', '/api/auth/signin/x%2F..%2F..%2F..%2Fw%2Fa')).toMatchObject({ kind: 'auth', level: 'high' });
        expect(classifyEdgeRequest('GET', '/api/auth/session/%2E%2E%2F%2E%2E%2Freadyz')).toMatchObject({ kind: 'auth', level: 'medium' });
        // And a spelling that only RESOLVES into the auth tier is in it too.
        expect(classifyEdgeRequest('POST', '/api/books/..%2Fauth/callback/credentials')).toMatchObject({ kind: 'auth', level: 'high' });
    });
});

describe('read tier', () => {
    it('keys on the workspace slug and the optional user', () => {
        expect(workspaceSlugOf(['api', 'w', 'my-book', 'x'])).toBe('my-book');
        expect(workspaceSlugOf(['api', 'books'])).toBeNull();
        expect(workspaceSlugOf(['api', 'w'])).toBeNull();
        // Read from the raw segment, as a /api/w/[slug] route reads it: a
        // `%2F..%2F` in a later segment cannot move the workspace.
        expect(classifyEdgeRequest('GET', '/api/w/acme/docs/x%2F..%2F..%2F..%2Fw%2Fother')).toMatchObject({
            kind: 'read',
            workspaceSlug: 'acme',
        });
        expect(classifyEdgeRequest('GET', '/api/w/My-Book/x')).toMatchObject({ kind: 'read', workspaceSlug: 'my-book' });
        expect(buildReadKey('my-book', '1.2.3.4', null)).toBe('w:my-book:ip:1.2.3.4:u:anon');
        expect(buildReadKey(null, '1.2.3.4', 'u1')).toBe('w:none:ip:1.2.3.4:u:u1');
    });

    it('blocks past API_READ_LIMIT per workspace', async () => {
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            expect((await proxy(req('/api/w/a/things'))).status).toBe(200);
        }
        expect((await proxy(req('/api/w/a/things'))).status).toBe(429);
        // Another workspace has its own budget.
        expect((await proxy(req('/api/w/b/things'))).status).toBe(200);
    });

    it('never the health probes, even with the bucket they would share exhausted', async () => {
        // A probe has no workspace, so if it were limited it would be keyed
        // `w:none:ip:<ip>:u:anon` — the bucket of every non-workspace GET
        // from this IP. Exhaust exactly that bucket first.
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) {
            expect((await proxy(req('/api/books'))).status).toBe(200);
        }
        expect((await proxy(req('/api/books'))).status).toBe(429);
        for (const probe of ['/api/readyz', '/api/livez', '/api/health']) {
            expect([probe, (await proxy(req(probe))).status]).toEqual([probe, 200]);
        }
    });
});

describe('request id', () => {
    it('keeps a well-formed caller id and replaces anything else', () => {
        const ok = new NextRequest('http://localhost/api/x', { headers: { 'x-request-id': 'abc.123' } });
        expect(requestIdFor(ok)).toBe('abc.123');
        const bad = new NextRequest('http://localhost/api/x', { headers: { 'x-request-id': '<b>' } });
        expect(requestIdFor(bad)).toMatch(/^[0-9a-f-]{36}$/);
    });
});
