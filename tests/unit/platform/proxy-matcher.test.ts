/**
 * The proxy's matcher and next.config.mjs's static-asset `headers()` PARTITION
 * every path (Phase 0.H review): each path is stamped by exactly one of them.
 * A path neither covers answers with no policy and no security headers; a
 * path both cover answers with two conflicting policies.
 *
 * Both are compiled with Next's OWN compilers — the proxy's matcher through
 * `getMiddlewareMatchers` + `getMiddlewareRouteMatcher` (what the build writes
 * to the middleware manifest and the server runs), the headers through
 * `buildCustomRoute` — so what is tested is what Next does with the strings,
 * not a reading of them. tests/e2e/security-headers.spec.ts asks the same
 * paths of the production server.
 *
 * The matcher used to be `/((?!_next/static|_next/image).*)`, a bare prefix:
 * `/_next/imagefoo`, `/_next/image_`, `/_next/static-x` and `/_next/staticx/a`
 * skipped the proxy and matched no header source, so the 404 page answered
 * them with no policy at all.
 */
jest.mock('next-auth/jwt', () => ({ getToken: jest.fn(async () => null) }));

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher';
import { buildCustomRoute } from 'next/dist/lib/build-custom-route';
import { config } from '@/proxy';
import { REPO_ROOT } from '../../helpers/repo-files';

// Exported at run time, absent from the package's declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info') as {
    getMiddlewareMatchers: (matcher: unknown, nextConfig: unknown) => unknown;
};

const proxyRuns = (() => {
    const matchers = getMiddlewareMatchers(config.matcher, {});
    const match = getMiddlewareRouteMatcher(matchers as never);
    return (pathname: string) => match(pathname, {} as never, {} as never);
})();

/** The header sources next.config.mjs declares (an ESM file Jest cannot load; its literals are read). */
const HEADER_SOURCES = Array.from(
    fs.readFileSync(path.join(REPO_ROOT, 'next.config.mjs'), 'utf8').matchAll(/\{\s*source:\s*'([^']+)',\s*headers:\s*STATIC_ASSET_HEADERS\s*\}/g),
    (m) => m[1],
);

const headersApply = (pathname: string) =>
    HEADER_SOURCES.some((source) => new RegExp(buildCustomRoute('header', { source, headers: [] }).regex).test(pathname));

/** The paths the review found (they reached neither), the assets, and their near neighbours. */
const DOCUMENT_PATHS = [
    '/_next/imagefoo',
    '/_next/image_',
    '/_next/static-x',
    '/_next/staticx/a',
    '/_next/static',
    '/_next/image/x',
    '/_next/images',
    '/_next/',
    '/_next',
    '/',
    '/login',
    '/api/health',
    '/api/w/a/members',
    '/no/such/page',
    '/x/_next/static/a.js',
];
const STATIC_PATHS = ['/_next/static/chunks/main.js', '/_next/static/css/a.css', '/_next/static/x', '/_next/image'];

it('read both header sources out of next.config.mjs (a parse that found none would pass)', () => {
    expect(HEADER_SOURCES).toEqual(['/_next/static/:path+', '/_next/image']);
});

it.each(DOCUMENT_PATHS)('%s is the proxy’s, and no header source claims it', (pathname) => {
    expect([pathname, proxyRuns(pathname), headersApply(pathname)]).toEqual([pathname, true, false]);
});

it.each(STATIC_PATHS)('%s is a static asset: next.config.mjs stamps it, the proxy skips it', (pathname) => {
    expect([pathname, proxyRuns(pathname), headersApply(pathname)]).toEqual([pathname, false, true]);
});

it('every probed path is stamped by exactly one of the two', () => {
    const both = [...DOCUMENT_PATHS, ...STATIC_PATHS].filter((p) => proxyRuns(p) === headersApply(p));
    expect(both).toEqual([]);
});
