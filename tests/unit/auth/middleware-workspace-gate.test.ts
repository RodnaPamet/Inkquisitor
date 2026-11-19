/**
 * The edge middleware's workspace gate, with the session cookie decoded by a
 * stubbed `getToken` (the gate reads the JWT claim only; the database check is
 * the route's).
 */
const tokenBox: { token: Record<string, unknown> | null } = { token: null };
jest.mock('next-auth/jwt', () => ({ getToken: jest.fn(async () => tokenBox.token) }));

import { NextRequest } from 'next/server';
import { middleware, isApiPath } from '@/middleware';
import { _clearApiReadRateLimitMemory } from '@/lib/rate-limit/apiReadRateLimit';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';

const MEMBER = { userId: 'user_1', memberships: [{ slug: 'ada', workspaceId: 'ws_1', role: 'OWNER' }], membershipsTruncated: false };

function req(path: string, method = 'GET') {
    return new NextRequest(`http://localhost${path}`, { method, headers: { 'x-forwarded-for': '203.0.113.50', 'user-agent': 'jest' } });
}

beforeEach(() => {
    tokenBox.token = null;
    _clearApiReadRateLimitMemory();
});
afterEach(() => {
    delete process.env.RATE_LIMIT_ENABLED;
});

describe('no session', () => {
    it('a workspace page redirects to /login, carrying where it was going', async () => {
        const res = await middleware(req('/w/ada/books?x=1'));
        expect(res.status).toBe(307);
        const location = new URL(res.headers.get('location')!);
        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('callbackUrl')).toBe('/w/ada/books?x=1');
    });

    it('a workspace API request answers 401 JSON with the request id', async () => {
        const res = await middleware(req('/api/w/ada/members'));
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('UNAUTHORIZED');
        expect(res.headers.get('x-request-id')).toBeTruthy();
    });
});

describe('a member', () => {
    beforeEach(() => {
        tokenBox.token = MEMBER;
    });

    it('passes to their workspace, pages and API alike', async () => {
        expect((await middleware(req('/w/ada/books'))).status).toBe(200);
        expect((await middleware(req('/api/w/ada/members'))).status).toBe(200);
        expect((await middleware(req('/api/w/ada/members/m1', 'PATCH'))).status).toBe(200);
    });

    it('is sent to /no-workspace for another workspace’s page, and refused 403 at its API', async () => {
        const page = await middleware(req('/w/other/books'));
        expect(page.status).toBe(307);
        expect(new URL(page.headers.get('location')!).pathname).toBe('/no-workspace');
        const api = await middleware(req('/api/w/other/members'));
        expect(api.status).toBe(403);
        expect((await api.json()).error.code).toBe('FORBIDDEN');
    });

    it.each([
        '/w/ada/x%2F..%2F..%2F..%2Fw%2Fother%2Fbooks',
        '/%77/other/books',
        '/W/other/books',
        '/w//other/books',
        '/books/..%2Fw%2Fother',
    ])('a crafted spelling cannot reach another workspace: %s', async (path) => {
        expect((await middleware(req(path))).status).toBe(307);
    });

    it.each(['/api/w/ada/x%2F..%2F..%2F..%2F..%2Fapi%2Fw%2Fother%2Fmembers', '/api/%77/other/members', '/api//w/other/members'])(
        'nor its API: %s',
        async (path) => {
            expect((await middleware(req(path))).status).toBe(403);
        },
    );
});

it('a session with no membership at all is refused', async () => {
    tokenBox.token = { userId: 'user_2', memberships: [], membershipsTruncated: false };
    expect((await middleware(req('/api/w/ada/members'))).status).toBe(403);
});

it('a capped claim list defers to the server gate', async () => {
    tokenBox.token = { ...MEMBER, membershipsTruncated: true };
    expect((await middleware(req('/api/w/beyond-the-cap/members'))).status).toBe(200);
});

it('pages outside workspaces are not gated', async () => {
    expect((await middleware(req('/api/health'))).status).toBe(200);
});

it('workspace PAGES are not charged to the read tier; workspace API reads are', async () => {
    process.env.RATE_LIMIT_ENABLED = '1';
    tokenBox.token = MEMBER;
    for (let i = 0; i < API_READ_LIMIT.maxAttempts + 5; i++) {
        expect((await middleware(req('/w/ada/books'))).status).toBe(200);
    }
    for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) await middleware(req('/api/w/ada/members'));
    expect((await middleware(req('/api/w/ada/members'))).status).toBe(429);
});

it('a refused request has still spent its read budget (probing slugs is counted)', async () => {
    process.env.RATE_LIMIT_ENABLED = '1';
    tokenBox.token = MEMBER;
    for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) expect((await middleware(req('/api/w/other/members'))).status).toBe(403);
    expect((await middleware(req('/api/w/other/members'))).status).toBe(429);
});

it('isApiPath judges every spelling', () => {
    expect(isApiPath('/api/w/a')).toBe(true);
    expect(isApiPath('/%61pi/w/a')).toBe(true);
    expect(isApiPath('/w/a/..%2F..%2Fapi%2Fhealth')).toBe(true);
    expect(isApiPath('/w/a/books')).toBe(false);
});
