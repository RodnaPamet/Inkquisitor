/**
 * Where tldraw finds its fonts, icons and translation: OUR origin, never
 * tldraw's CDN (Phase 3.1).
 *
 * tldraw loads these from `cdn.tldraw.com` unless told otherwise, and the
 * content-security policy (`src/lib/security/csp.ts`) admits no other origin
 * for fonts, images or fetches: without this the toolbar's icons and the
 * canvas fonts would be refused, and every page view would tell a third
 * party who is reading which map. `@tldraw/assets` (the same release as
 * tldraw, its licence) ships the files; `getAssetUrls` points each at
 * `/api/canvas-assets/<version>/…`, which serves them from the installed
 * package (`src/app/api/canvas-assets/[...asset]/route.ts`).
 *
 * The version is in the path so a browser may cache a file for good: a new
 * tldraw release is a new URL.
 *
 * Client-safe.
 */
import { getAssetUrls } from '@tldraw/assets/selfHosted';

/** The `@tldraw/assets` release whose files the route serves (and the path names). */
export const TLDRAW_ASSETS_VERSION = '3.15.6';

/** The path every canvas asset is served under. */
export const CANVAS_ASSET_BASE = `/api/canvas-assets/${TLDRAW_ASSETS_VERSION}`;

/** The asset URLs `<Tldraw assetUrls>` takes. */
export function canvasAssetUrls() {
    return getAssetUrls({ baseUrl: CANVAS_ASSET_BASE });
}

/**
 * The files the route serves: the fonts, the merged icon sprite, the embed
 * icons tldraw preloads before it shows anything (it waits for every one to
 * decode; embeds themselves are switched off) and the English translation
 * (the UI's only locale, D12). A path outside these shapes is a 404 before
 * the filesystem is asked.
 */
export const CANVAS_ASSET_PATH = /^(?:fonts\/[A-Za-z0-9_-]{1,64}\.woff2|icons\/icon\/0_merged\.svg|embed-icons\/[a-z0-9_]{1,64}\.png|translations\/en\.json)$/;
