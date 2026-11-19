/**
 * Every rate-limit tier keys on the client address the TRUSTED proxy saw
 * (issue #5), never on the leftmost X-Forwarded-For entry, which the client
 * writes. Production runs behind one Caddy (`TRUSTED_PROXY_HOPS=1`, the
 * default): the client is the last entry.
 *
 * Each tier is driven the way an attacker would drive it — a fresh spoofed
 * leftmost entry on every request — and must charge every request to the one
 * real address.
 */
jest.mock('next-auth/jwt', () => ({ getToken: jest.fn(async () => null) }));

import { NextRequest } from 'next/server';
import { UNKNOWN_CLIENT, clientIpFrom, normaliseAddress, trustedProxyHops } from '@/lib/http/client-ip';
import { proxy } from '@/proxy';
import { _clearAuthRateLimitMemory, AUTH_TIER_POLICIES } from '@/lib/rate-limit/authRateLimit';
import { _clearApiReadRateLimitMemory } from '@/lib/rate-limit/apiReadRateLimit';
import { enforceRateLimit, getClientIp } from '@/lib/security/rate-limit-middleware';
import { API_READ_LIMIT, LOGIN_LIMIT, clearAllRateLimits } from '@/lib/security/rate-limit';

const REAL = '198.51.100.77';
const xff = (value: string | null) => new Headers(value === null ? {} : { 'x-forwarded-for': value });
let spoofCounter = 0;
const spoofed = () => `10.${(spoofCounter >> 16) & 255}.${(spoofCounter >> 8) & 255}.${spoofCounter++ & 255}`;

afterEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
    delete process.env.RATE_LIMIT_ENABLED;
});

describe('clientIpFrom', () => {
    it('one trusted hop: the last entry, whatever the client put before it', () => {
        expect(clientIpFrom(xff(REAL), 1)).toBe(REAL);
        expect(clientIpFrom(xff(`6.6.6.6, ${REAL}`), 1)).toBe(REAL);
        expect(clientIpFrom(xff(`1.1.1.1, 2.2.2.2,3.3.3.3 , ${REAL}`), 1)).toBe(REAL);
    });

    it('two trusted hops: the second entry from the right', () => {
        expect(clientIpFrom(xff(`6.6.6.6, ${REAL}, 192.0.2.1`), 2)).toBe(REAL);
        // Fewer entries than hops: the outermost proxy's entry, never further left.
        expect(clientIpFrom(xff(REAL), 2)).toBe(REAL);
    });

    it('zero hops trusts no forwarded header: everyone shares one bucket', () => {
        expect(clientIpFrom(xff(`6.6.6.6, ${REAL}`), 0)).toBe(UNKNOWN_CLIENT);
    });

    it('a missing, empty or malformed header falls back to the shared bucket, never to the string sent', () => {
        expect(clientIpFrom(xff(null), 1)).toBe(UNKNOWN_CLIENT);
        expect(clientIpFrom(xff(''), 1)).toBe(UNKNOWN_CLIENT);
        expect(clientIpFrom(xff(' , ,'), 1)).toBe(UNKNOWN_CLIENT);
        expect(clientIpFrom(xff('not-an-address'), 1)).toBe(UNKNOWN_CLIENT);
        expect(clientIpFrom(xff(`${REAL}, x'; DROP TABLE`), 1)).toBe(UNKNOWN_CLIENT);
        expect(clientIpFrom(xff('999.1.1.1'), 1)).toBe(UNKNOWN_CLIENT);
        expect(clientIpFrom(xff('a'.repeat(10_000)), 1)).toBe(UNKNOWN_CLIENT);
        // X-Real-IP is as forgeable as the leftmost entry, and is not read.
        expect(clientIpFrom(new Headers({ 'x-real-ip': REAL }), 1)).toBe(UNKNOWN_CLIENT);
    });

    it('normalises the forms a proxy writes', () => {
        expect(normaliseAddress('198.51.100.77:4321')).toBe(REAL);
        expect(normaliseAddress('[2001:DB8::1]:443')).toBe('2001:db8::1');
        expect(normaliseAddress('2001:db8::1')).toBe('2001:db8::1');
        expect(normaliseAddress('::ffff:192.0.2.1')).toBe('::ffff:192.0.2.1');
        expect(normaliseAddress('localhost')).toBeNull();
    });

    it('reads TRUSTED_PROXY_HOPS, defaulting to one hop', () => {
        expect(trustedProxyHops()).toBe(1);
        process.env.TRUSTED_PROXY_HOPS = '2';
        expect(trustedProxyHops()).toBe(2);
        expect(clientIpFrom(xff(`6.6.6.6, ${REAL}, 192.0.2.1`))).toBe(REAL);
        process.env.TRUSTED_PROXY_HOPS = '0';
        expect(clientIpFrom(xff(REAL))).toBe(UNKNOWN_CLIENT);
        process.env.TRUSTED_PROXY_HOPS = 'many';
        expect(trustedProxyHops()).toBe(1);
    });
});

function req(path: string, forwardedFor: string, method = 'GET') {
    return new NextRequest(`http://localhost${path}`, { method, headers: { 'x-forwarded-for': forwardedFor, 'user-agent': 'jest' } });
}

describe('a spoofed leftmost entry is charged to the real client', () => {
    beforeEach(() => {
        process.env.RATE_LIMIT_ENABLED = '1';
        _clearAuthRateLimitMemory();
        _clearApiReadRateLimitMemory();
        clearAllRateLimits();
    });

    it('the auth tier (edge)', async () => {
        for (let i = 0; i < AUTH_TIER_POLICIES.high.limit; i++) {
            expect((await proxy(req('/api/auth/signin', `${spoofed()}, ${REAL}`, 'POST'))).status).toBe(200);
        }
        expect((await proxy(req('/api/auth/signin', `${spoofed()}, ${REAL}`, 'POST'))).status).toBe(429);
        // Another real client is untouched.
        expect((await proxy(req('/api/auth/signin', `${REAL}, 198.51.100.78`, 'POST'))).status).toBe(200);
    });

    it('the read tier (edge)', async () => {
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) await proxy(req('/api/books', `${spoofed()}, ${REAL}`));
        expect((await proxy(req('/api/books', `${spoofed()}, ${REAL}`))).status).toBe(429);
        expect((await proxy(req('/api/books', '198.51.100.78'))).status).toBe(200);
    });

    it('LOGIN_LIMIT and the mutation tier (Node route handlers)', () => {
        const scope = { scope: 'login', config: LOGIN_LIMIT };
        const r = () => new Request('http://localhost/api/auth/callback/credentials', { method: 'POST', headers: { 'x-forwarded-for': `${spoofed()}, ${REAL}` } });
        expect(getClientIp(r())).toBe(REAL);
        for (let i = 0; i < LOGIN_LIMIT.maxAttempts; i++) expect(enforceRateLimit(r(), scope).response).toBeUndefined();
        expect(enforceRateLimit(r(), scope).response?.status).toBe(429);
    });
});
