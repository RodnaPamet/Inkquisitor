/**
 * The content-security policy admits tldraw's watermark-tracking request and
 * nothing broader (decision D20).
 *
 * The URL is derived from the installed @tldraw/editor — its CDN base, its
 * version and the path its licence manager fetches — so a tldraw release that
 * moves the request fails here rather than as a console violation in
 * production. And the policy names that host in connect-src only, by the full
 * path: never the origin alone, never in another directive.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TLDRAW_WATERMARK_TRACK_URL, buildCspHeader } from '@/lib/security/csp';
import { REPO_ROOT } from '../../helpers/repo-files';

const EDITOR = path.join(REPO_ROOT, 'node_modules/@tldraw/editor/dist-cjs');
const read = (rel: string) => fs.readFileSync(path.join(EDITOR, rel), 'utf8');

function directives(csp: string): Map<string, string[]> {
    return new Map(
        csp.split(';').map((d) => {
            const [name, ...values] = d.trim().split(/\s+/);
            return [name, values] as const;
        }),
    );
}

it('the URL is the one @tldraw/editor’s licence manager fetches, at its own version', () => {
    const licence = read('lib/license/LicenseManager.js');
    const trackPath = /const WATERMARK_TRACK_SRC = `\$\{\(0, import_assets\.getDefaultCdnBaseUrl\)\(\)\}(\/watermarks\/[a-z-]+\.svg)`;/.exec(licence)?.[1];
    // A fetch, so connect-src governs it (not img-src).
    expect(licence).toContain('(0, import_utils.fetch)(WATERMARK_TRACK_SRC)');
    const cdn = /const CDN_BASE_URL = "(https:\/\/[a-z.]+)";/.exec(read('lib/utils/assets.js'))?.[1];
    expect(read('lib/utils/assets.js')).toContain('return `${CDN_BASE_URL}/${import_version.version}`;');
    const version = /const version = "(\d+\.\d+\.\d+)";/.exec(read('version.js'))?.[1];
    expect([cdn, version, trackPath].every(Boolean)).toBe(true);
    expect(TLDRAW_WATERMARK_TRACK_URL).toBe(`${cdn}/${version}${trackPath}`);
});

describe.each([false, true])('the policy (development: %s)', (isDev) => {
    const csp = buildCspHeader('AAAAAAAAAAAAAAAAAAAAAA==', isDev);
    const parsed = directives(csp);

    it('connect-src admits the watermark-track URL by its full path', () => {
        const connect = parsed.get('connect-src') ?? [];
        expect(connect.slice(0, 2)).toEqual(["'self'", TLDRAW_WATERMARK_TRACK_URL]);
        expect(connect.slice(2)).toEqual(isDev ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : []);
    });

    it('no other directive names tldraw’s CDN, and nothing names it without that path', () => {
        for (const [name, values] of parsed) {
            for (const v of values) {
                if (!v.includes('tldraw')) continue;
                expect([name, v]).toEqual(['connect-src', TLDRAW_WATERMARK_TRACK_URL]);
            }
        }
        expect(csp.split('cdn.tldraw.com').length - 1).toBe(1);
        // No scheme-wide or wildcard host source anywhere.
        const all = [...parsed.values()].flat();
        expect(all.filter((v) => v === 'https:' || v.includes('*.') || v.startsWith('https://*'))).toEqual([]);
    });
});
