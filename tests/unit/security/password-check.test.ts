/**
 * The breached-password check (HIBP range API, k-anonymity), with an injected
 * fetch: no test reaches the real service.
 */
import { createHash } from 'node:crypto';
import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';

const PASSWORD = ['correct', 'horse'].join('-');
const sha1 = createHash('sha1').update(PASSWORD).digest('hex').toUpperCase();
const prefix = sha1.slice(0, 5);
const suffix = sha1.slice(5);

function fakeFetch(body: string, status = 200) {
    return jest.fn<Promise<Response>, [string | URL | Request, RequestInit?]>(async () => new Response(body, { status }));
}

it('sends only the first five hex characters of the SHA-1, with padding requested', async () => {
    const fetchImpl = fakeFetch('');
    await checkPasswordAgainstHIBP(PASSWORD, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
    expect(String(url)).not.toContain(suffix);
    expect((init?.headers as Record<string, string>)['Add-Padding']).toBe('true');
});

it('reports a breached password with its count', async () => {
    const body = `0000000000000000000000000000000000A:3\r\n${suffix}:42\r\n`;
    expect(await checkPasswordAgainstHIBP(PASSWORD, { fetchImpl: fakeFetch(body) as unknown as typeof fetch })).toEqual({ breached: true, occurrences: 42 });
});

it('ignores padding rows (count 0) and other suffixes', async () => {
    const body = `${suffix}:0\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:9\r\n`;
    expect(await checkPasswordAgainstHIBP(PASSWORD, { fetchImpl: fakeFetch(body) as unknown as typeof fetch })).toEqual({ breached: false });
});

it('fails OPEN on an upstream error or a network failure, saying it skipped', async () => {
    expect(await checkPasswordAgainstHIBP(PASSWORD, { fetchImpl: fakeFetch('', 503) as unknown as typeof fetch })).toEqual({
        breached: false,
        skipped: true,
        reason: 'upstream_error',
    });
    const throwing = jest.fn(async () => {
        throw new TypeError('fetch failed');
    });
    expect(await checkPasswordAgainstHIBP(PASSWORD, { fetchImpl: throwing as unknown as typeof fetch })).toEqual({
        breached: false,
        skipped: true,
        reason: 'network',
    });
});
