/**
 * Every rate-limit line the proxy's tiers log names the request id the proxy
 * answered with (issue #7: they read "unknown", so a 429 a client reported
 * could not be found in the logs).
 */
jest.mock('next-auth/jwt', () => ({
    getToken: jest.fn(async () => ({ userId: 'user_rid', memberships: [{ slug: '_', workspaceId: 'ws_', role: 'OWNER' }], membershipsTruncated: true })),
}));

import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { _setEdgeLogSink } from '@/lib/observability/edge-logger';
import { _clearAuthRateLimitMemory, AUTH_TIER_POLICIES } from '@/lib/rate-limit/authRateLimit';
import { _clearApiReadRateLimitMemory } from '@/lib/rate-limit/apiReadRateLimit';
import * as windowStore from '@/lib/rate-limit/window-store';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';

const lines: Array<{ level: string; entry: Record<string, unknown> }> = [];

function req(path: string, requestId: string | null, method = 'GET') {
    return new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'jest', ...(requestId ? { 'x-request-id': requestId } : {}) },
    });
}

beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = '1';
    _clearAuthRateLimitMemory();
    _clearApiReadRateLimitMemory();
    lines.length = 0;
    _setEdgeLogSink((level, line) => void lines.push({ level, entry: JSON.parse(line) }));
});
afterEach(() => {
    _setEdgeLogSink(null);
    delete process.env.RATE_LIMIT_ENABLED;
    jest.restoreAllMocks();
});

it('the read tier names the caller’s request id on its 429 line', async () => {
    for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) await proxy(req('/api/books', null));
    const res = await proxy(req('/api/books', 'rid-read-429'));
    expect(res.status).toBe(429);
    expect(res.headers.get('x-request-id')).toBe('rid-read-429');
    const blocked = lines.filter((l) => l.entry.msg === 'API read rate limit exceeded');
    expect(blocked.map((l) => l.entry.requestId)).toEqual(['rid-read-429']);
});

it('the auth tier names it too, and a minted id when the caller sent none', async () => {
    for (let i = 0; i < AUTH_TIER_POLICIES.high.limit; i++) await proxy(req('/api/auth/signin', null, 'POST'));
    const res = await proxy(req('/api/auth/signin', null, 'POST'));
    expect(res.status).toBe(429);
    const minted = res.headers.get('x-request-id');
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    const blocked = lines.filter((l) => l.entry.msg === 'auth rate limit exceeded');
    expect(blocked.map((l) => l.entry.requestId)).toEqual([minted]);
});

it('a store failure (the tier fails open) is logged with the request id', async () => {
    jest.spyOn(windowStore, 'checkWindow').mockRejectedValue(new Error('upstash down'));
    expect((await proxy(req('/api/books', 'rid-open-read'))).status).toBe(200);
    expect((await proxy(req('/api/auth/session', 'rid-open-auth'))).status).toBe(200);
    expect(lines.filter((l) => l.level === 'error').map((l) => l.entry.requestId)).toEqual(['rid-open-read', 'rid-open-auth']);
    expect(lines.every((l) => l.entry.requestId !== 'unknown')).toBe(true);
});
