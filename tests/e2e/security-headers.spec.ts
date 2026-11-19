import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { HSTS_HEADER, SECURITY_HEADERS, STATIC_ASSET_CSP } from '../../src/lib/security/csp';
import { signUp } from './helpers';

/**
 * Security headers and the content-security policy on EVERY response of the
 * production build (Phase 0.H, brief item 6): pages, the proxy's own
 * redirects and refusals, route handlers, the 404 page, the probes, and the
 * static assets the proxy does not run for (next.config.mjs stamps those).
 * The expected values are imported from src/lib/security/csp.ts, so this is
 * also the check that next.config.mjs's copy of the list has not drifted.
 *
 * And the policy WORKS: every script the server emits carries this request's
 * nonce, the nonce changes per request, and a browser walking the product —
 * sign-up included — reports no violation (a page whose scripts the policy
 * blocked would not hydrate, and the sign-up would not land).
 */

type Kind = 'document' | 'static';

function expectHeaders(res: APIResponse, kind: Kind, what: string): string {
    const h = res.headers();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect([what, name, h[name.toLowerCase()]]).toEqual([what, name, value]);
    }
    // `next start` is a production server: HSTS on every response.
    expect([what, h[HSTS_HEADER.name.toLowerCase()]]).toEqual([what, HSTS_HEADER.value]);
    const csp = h['content-security-policy'];
    expect([what, typeof csp]).toEqual([what, 'string']);
    if (kind === 'static') {
        expect([what, csp]).toEqual([what, STATIC_ASSET_CSP]);
    } else {
        const scriptSrc = /(?:^|;\s*)script-src ([^;]*)/.exec(csp)?.[1] ?? '';
        expect([what, scriptSrc]).toEqual([what, expect.stringMatching(/'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/)]);
        expect([what, scriptSrc.includes('unsafe-inline'), scriptSrc.includes('unsafe-eval')]).toEqual([what, false, false]);
        expect([what, csp]).toEqual([what, expect.stringContaining("frame-ancestors 'none'")]);
        expect([what, csp]).toEqual([what, expect.stringContaining("object-src 'none'")]);
    }
    return csp;
}

const nonceOf = (csp: string) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1] ?? '';

test('every kind of response carries the headers and a policy', async ({ request }) => {
    // The readiness probe answers 200 or 503 depending on the machine's Redis;
    // its headers are what is checked.
    const responses: Array<[string, () => Promise<APIResponse>, number | 'any']> = [
        ['landing page', () => request.get('/'), 200],
        ['sign-in page', () => request.get('/login'), 200],
        ['sign-up page', () => request.get('/signup'), 200],
        ['no-workspace page', () => request.get('/no-workspace'), 200],
        ['proxy redirect (signed out)', () => request.get('/w/somebody/books', { maxRedirects: 0 }), 307],
        ['proxy 401 (workspace API, signed out)', () => request.get('/api/w/somebody/members'), 401],
        ['route handler 401 (account API)', () => request.get('/api/account/sessions'), 401],
        ['route handler 400 (bad sign-up body)', () => request.post('/api/auth/register', { data: { nope: 1 } }), 400],
        ['NextAuth route', () => request.get('/api/auth/csrf'), 200],
        ['liveness probe', () => request.get('/api/health'), 200],
        ['readiness probe', () => request.get('/api/readyz'), 'any'],
        ['404 page', () => request.get('/no/such/page'), 404],
        ['HEAD of a page', () => request.head('/login'), 200],
    ];
    for (const [what, send, status] of responses) {
        const res = await send();
        if (status !== 'any') expect([what, res.status()]).toEqual([what, status]);
        expectHeaders(res, 'document', what);
    }

    // A static chunk the sign-in page loads, and a missing one.
    const html = await (await request.get('/login')).text();
    const chunk = /<script[^>]+src="(\/_next\/static\/[^"]+\.js)"/.exec(html)?.[1];
    expect(chunk).toBeTruthy();
    const asset = await request.get(chunk!);
    expect(asset.status()).toBe(200);
    expectHeaders(asset, 'static', 'static chunk');
    const missing = await request.get('/_next/static/chunks/does-not-exist.js');
    expectHeaders(missing, 'static', 'missing static chunk');
});

test('every script the server emits carries this request’s nonce, and the nonce is fresh per request', async ({ request }) => {
    const nonces = new Set<string>();
    for (const path of ['/', '/login', '/signup']) {
        const res = await request.get(path);
        const nonce = nonceOf(expectHeaders(res, 'document', path));
        nonces.add(nonce);
        const tags = [...(await res.text()).matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
        expect([path, tags.length > 3]).toEqual([path, true]);
        const executable = tags.filter((t) => !/type="application\/(?:ld\+)?json"/i.test(t));
        const wrong = executable.filter((t) => !t.includes(`nonce="${nonce}"`));
        expect([path, wrong]).toEqual([path, []]);
    }
    expect(nonces.size).toBe(3);
});

function watchViolations(page: Page): string[] {
    const seen: string[] = [];
    page.on('console', (msg) => {
        if (/Content[- ]Security[- ]Policy|Refused to (?:execute|load|apply|connect)/i.test(msg.text())) seen.push(msg.text());
    });
    return seen;
}

test('a browser walking the product sees no policy violation, and the pages hydrate', async ({ page }) => {
    const violations = watchViolations(page);
    await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
            (window as unknown as { __cspViolations: string[] }).__cspViolations ??= [];
            (window as unknown as { __cspViolations: string[] }).__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
        });
    });
    await page.goto('/');
    await page.goto('/login');
    // Sign-up is a client form: it lands only if the page's scripts ran.
    const slug = await signUp(page);
    await page.goto(`/w/${slug}/settings`);
    await expect(page.locator('#settings-sessions')).toContainText('This browser');
    const fromEvents = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
    expect({ console: violations, events: fromEvents }).toEqual({ console: [], events: [] });
});
