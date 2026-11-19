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
import {
    UNKNOWN_CLIENT,
    clientIpFrom,
    clientRateLimitKeyFrom,
    normaliseAddress,
    parseIpv6,
    rateLimitKeyFor,
    trustedProxyHops,
} from '@/lib/http/client-ip';
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
        expect(normaliseAddress('localhost')).toBeNull();
    });

    it('every spelling of one IPv6 address is one string (RFC 5952)', () => {
        for (const spelling of ['2001:db8::1', '2001:db8:0:0::1', '2001:DB8:0000:0000:0000:0000:0000:0001', '2001:db8:0:0:0:0:0:1', '[2001:db8::0:1]:80']) {
            expect([spelling, normaliseAddress(spelling)]).toEqual([spelling, '2001:db8::1']);
        }
        expect(normaliseAddress('0:0:0:0:0:0:0:0')).toBe('::');
        expect(normaliseAddress('::1')).toBe('::1');
        // The longest zero run is compressed; a single zero group is not.
        expect(normaliseAddress('2001:0:0:1:0:0:0:1')).toBe('2001:0:0:1::1');
        expect(normaliseAddress('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
        expect(normaliseAddress('64:ff9b::192.0.2.33')).toBe('64:ff9b::c000:221');
    });

    it('an IPv4-mapped IPv6 address is the IPv4 client it carries', () => {
        expect(normaliseAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
        expect(normaliseAddress('::FFFF:c000:0201')).toBe('192.0.2.1');
        expect(normaliseAddress('0:0:0:0:0:ffff:192.0.2.1')).toBe('192.0.2.1');
        expect(normaliseAddress('[::ffff:192.0.2.1]:443')).toBe('192.0.2.1');
    });

    it('malformed IPv6 is refused into the shared bucket, never kept as a string', () => {
        for (const bad of [':::::::', 'a:b', '1:2:3:4:5:6:7:8:9', '1::2::3', '::g', '12345::1', '1:2:3:4:5:6:7', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:', '1:2:3:4:5:6:7::8', '::1.2.3', '::1.2.3.4.5', '::256.1.1.1', '1.2.3.4::', 'fe80::1%eth0', '[1.2.3.4]', '::ffff:1.2.3.04']) {
            expect([bad, normaliseAddress(bad)]).toEqual([bad, null]);
            expect([bad, clientIpFrom(xff(bad), 1)]).toEqual([bad, UNKNOWN_CLIENT]);
        }
        expect(parseIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(parseIpv6('1::8')).toEqual([1, 0, 0, 0, 0, 0, 0, 8]);
    });

    it('an IPv6 client is keyed on its /64; IPv4 on the address; unknown stays shared', () => {
        expect(rateLimitKeyFor('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
        expect(rateLimitKeyFor('2001:db8::1')).toBe('2001:db8::/64');
        expect(rateLimitKeyFor(REAL)).toBe(REAL);
        expect(rateLimitKeyFor(UNKNOWN_CLIENT)).toBe(UNKNOWN_CLIENT);
        expect(clientRateLimitKeyFrom(xff('2001:DB8:1:2::ffff'), 1)).toBe('2001:db8:1:2::/64');
        expect(clientRateLimitKeyFrom(xff('::ffff:198.51.100.77'), 1)).toBe(REAL);
        // The full address is still what the session record keeps.
        expect(clientIpFrom(xff('2001:DB8:1:2::ffff'), 1)).toBe('2001:db8:1:2::ffff');
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

/** A fresh address inside one /64 on every call: what a subscriber holding the /64 can send. */
let v6Counter = 1;
const sameSlash64 = () => `2001:db8:aa:bb:${(v6Counter >> 16).toString(16)}:${(v6Counter++ & 0xffff).toString(16)}:0:1`;

describe('every tier keys on the masked, canonical key', () => {
    beforeEach(() => {
        process.env.RATE_LIMIT_ENABLED = '1';
        _clearAuthRateLimitMemory();
        _clearApiReadRateLimitMemory();
        clearAllRateLimits();
    });

    it('the auth tier: one /64 is one budget, however many addresses it sends from', async () => {
        for (let i = 0; i < AUTH_TIER_POLICIES.high.limit; i++) {
            expect((await proxy(req('/api/auth/signin', sameSlash64(), 'POST'))).status).toBe(200);
        }
        expect((await proxy(req('/api/auth/signin', sameSlash64(), 'POST'))).status).toBe(429);
        // The next /64 is another client.
        expect((await proxy(req('/api/auth/signin', '2001:db8:aa:bc::1', 'POST'))).status).toBe(200);
    });

    it('the auth tier: spellings of one address, and its IPv4-mapped form, are one budget', async () => {
        const spellings = ['198.51.100.9', '::ffff:198.51.100.9', '[::FFFF:198.51.100.9]:1234', '0:0:0:0:0:ffff:c633:6409', '198.51.100.9:80'];
        for (let i = 0; i < AUTH_TIER_POLICIES.high.limit; i++) {
            expect((await proxy(req('/api/auth/signin', spellings[i % spellings.length], 'POST'))).status).toBe(200);
        }
        expect((await proxy(req('/api/auth/signin', spellings[0], 'POST'))).status).toBe(429);
    });

    it('the auth tier: a fresh User-Agent per request buys no fresh budget', async () => {
        const statuses: number[] = [];
        for (let i = 0; i < AUTH_TIER_POLICIES.high.limit + 2; i++) {
            const r = new NextRequest('http://localhost/api/auth/callback/credentials', {
                method: 'POST',
                headers: { 'x-forwarded-for': '198.51.100.21', 'user-agent': `agent-${i}` },
            });
            statuses.push((await proxy(r)).status);
        }
        expect(statuses.slice(0, AUTH_TIER_POLICIES.high.limit).every((s) => s === 200)).toBe(true);
        expect(statuses.slice(AUTH_TIER_POLICIES.high.limit)).toEqual([429, 429]);
    });

    it('the read tier: one /64 is one budget', async () => {
        for (let i = 0; i < API_READ_LIMIT.maxAttempts; i++) await proxy(req('/api/books', sameSlash64()));
        expect((await proxy(req('/api/books', sameSlash64()))).status).toBe(429);
        expect((await proxy(req('/api/books', '2001:db8:aa:bc::1'))).status).toBe(200);
    });

    it('LOGIN_LIMIT and the mutation tier: one /64 is one budget', () => {
        const scope = { scope: 'login', config: LOGIN_LIMIT };
        const r = () => new Request('http://localhost/api/auth/callback/credentials', { method: 'POST', headers: { 'x-forwarded-for': sameSlash64() } });
        expect(getClientIp(r())).toBe('2001:db8:aa:bb::/64');
        for (let i = 0; i < LOGIN_LIMIT.maxAttempts; i++) expect(enforceRateLimit(r(), scope).response).toBeUndefined();
        expect(enforceRateLimit(r(), scope).response?.status).toBe(429);
    });
});

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
