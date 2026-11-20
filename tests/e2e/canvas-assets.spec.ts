import { expect, test } from '@playwright/test';
import { CANVAS_ASSET_BASE, TLDRAW_ASSETS_VERSION } from '../../src/lib/canvas/tldraw-assets';

/**
 * The public tldraw asset route (`/api/canvas-assets/<version>/…`, Phase 3.1)
 * probed with real requests against the production build: the files tldraw
 * needs are served with their type and an immutable cache, and nothing else
 * of the package or the filesystem is — not by a dot segment, an encoded
 * one, an encoded slash, a backslash, a NUL, a doubled encoding, another
 * version or a near-miss of an allowed name.
 */

test('serves the allowlisted files with their content type, an immutable cache and the security headers', async ({ request }) => {
    const cases: Array<[string, string]> = [
        ['translations/en.json', 'application/json'],
        ['icons/icon/0_merged.svg', 'image/svg+xml'],
        ['fonts/IBMPlexMono-Medium.woff2', 'font/woff2'],
    ];
    for (const [rel, type] of cases) {
        const res = await request.get(`${CANVAS_ASSET_BASE}/${rel}`);
        expect([rel, res.status()]).toEqual([rel, 200]);
        const h = res.headers();
        expect([rel, h['content-type']]).toEqual([rel, type]);
        expect([rel, h['cache-control']]).toEqual([rel, 'public, max-age=31536000, immutable']);
        expect([rel, h['x-content-type-options']]).toEqual([rel, 'nosniff']);
        expect([rel, typeof h['content-security-policy']]).toEqual([rel, 'string']);
    }
});

test('refuses every path outside the allowlist, however it is spelled', async ({ request }) => {
    const base = `/api/canvas-assets/${TLDRAW_ASSETS_VERSION}`;
    const probes = [
        `${base}/package.json`,
        `${base}/LICENSE.md`,
        `${base}/selfHosted.js`,
        `${base}/translations/de.json`,
        `${base}/translations/en.json/`,
        `${base}/translations/EN.json`,
        `${base}/translations/en.json%00`,
        `${base}/translations/en.json%00.png`,
        `${base}/fonts/..%2fpackage.json`,
        `${base}/fonts%2F..%2Fpackage.json`,
        `${base}/fonts%2F..%2F..%2F..%2Fpackage.json`,
        `${base}/fonts/%2e%2e/package.json`,
        `${base}/fonts/%252e%252e/%252e%252e/package.json`,
        `${base}/fonts/..%5c..%5cpackage.json`,
        `${base}/fonts\\..\\package.json`,
        `${base}/icons/icon/0_merged.svg%2F..%2F..%2F..%2Fpackage.json`,
        `${base}/embed-icons/..%2f..%2f..%2f..%2f..%2fpackage.json`,
        `${base}/embed-icons/%2Fetc%2Fpasswd`,
        `/api/canvas-assets/..%2F${TLDRAW_ASSETS_VERSION}/translations/en.json`,
        `/api/canvas-assets/3.15.5/translations/en.json`,
        `/api/canvas-assets/${TLDRAW_ASSETS_VERSION}`,
        `/api/canvas-assets/%2Fetc%2Fpasswd`,
    ];
    for (const probe of probes) {
        const res = await request.get(probe, { maxRedirects: 0 });
        const body = await res.text();
        // A 4xx; or Next's own trailing-slash redirect, to the slash-less path (which the allowlist judges again).
        const status = res.status();
        const redirect = status === 308 ? (res.headers()['location'] ?? '') : null;
        expect([probe, (status >= 400 && status < 500) || (redirect !== null && !redirect.endsWith('/'))]).toEqual([probe, true]);
        expect([probe, body.includes('"name"') || body.includes('root:') || body.includes('This code is licensed')]).toEqual([probe, false]);
    }
});
