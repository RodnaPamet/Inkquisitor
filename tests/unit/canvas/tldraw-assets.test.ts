/**
 * tldraw's fonts, icons and translation come from our origin (Phase 3.1):
 * every URL the canvas hands tldraw is under the asset route, none is the
 * CDN, and the route's allowlist admits exactly the files it must.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CANVAS_ASSET_BASE, CANVAS_ASSET_PATH, TLDRAW_ASSETS_VERSION, canvasAssetUrls } from '@/lib/canvas/tldraw-assets';
import { REPO_ROOT } from '../../helpers/repo-files';

function allUrls(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (value && typeof value === 'object') return Object.values(value).flatMap(allUrls);
    return [];
}

it('the asset path names the installed @tldraw/assets release, which is tldraw’s own', () => {
    const assets = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'node_modules/@tldraw/assets/package.json'), 'utf8'));
    expect(assets.version).toBe(TLDRAW_ASSETS_VERSION);
});

it('every font, icon and translation URL is ours, never a CDN', () => {
    const urls = allUrls(canvasAssetUrls());
    expect(urls.length).toBeGreaterThan(30);
    for (const url of urls) expect(url.startsWith(`${CANVAS_ASSET_BASE}/`)).toBe(true);
});

it('every font, the icon sprite and every embed icon tldraw preloads are served; other paths are not', () => {
    const urls = canvasAssetUrls();
    const served = [...Object.values(urls.fonts), (urls.icons as Record<string, string>)['tool-arrow'].split('#')[0], ...Object.values(urls.embedIcons), urls.translations.en].map((u) =>
        u.slice(CANVAS_ASSET_BASE.length + 1),
    );
    for (const rel of served) {
        expect(rel).toMatch(CANVAS_ASSET_PATH);
        expect(fs.existsSync(path.join(REPO_ROOT, 'node_modules/@tldraw/assets', rel))).toBe(true);
    }
    for (const rel of ['../package.json', 'fonts/../../x.woff2', 'translations/de.json', 'icons/icon/arrow.svg', 'LICENSE.md', 'fonts/a.woff2/x']) {
        expect(CANVAS_ASSET_PATH.test(rel)).toBe(false);
    }
});
