/**
 * The content-security policy and the other security headers (Phase 0.H).
 *
 *   src/proxy.ts → generateNonce() → buildCspHeader(nonce)
 *     · sets the policy on the REQUEST (Next reads it there to stamp its own
 *       `<script>` tags with the nonce) and `x-csp-nonce` (the root layout
 *       reads it for the two inline scripts it renders);
 *     · sets the policy and `SECURITY_HEADERS` on the RESPONSE — every
 *       response the proxy returns, including its own 401s, 403s, 429s and
 *       redirects.
 *   next.config.mjs → the same headers, with `STATIC_ASSET_CSP`, on the
 *     static assets the proxy does not run for (`/_next/static`).
 *
 * THE POLICY. script-src carries no 'unsafe-inline' in any environment: a
 * per-request nonce plus 'strict-dynamic', so a script runs only when the
 * server rendered it with this request's nonce or a trusted script created it.
 * `next build --webpack` is what makes dynamically loaded chunks carry the
 * nonce (`__webpack_nonce__`, set by the root layout); Turbopack's runtime
 * sets none (inflect-compliance, 2026-06-05). Development adds 'unsafe-eval'
 * (React Refresh evaluates modules) and the HMR websocket.
 *
 * style-src allows 'unsafe-inline' and carries NO nonce: under CSP Level 3 a
 * nonce in style-src makes the browser ignore 'unsafe-inline', and the UI
 * platform (Radix, TipTap, the charts) writes `style=""` attributes, which no
 * nonce can cover. CSS injection's blast radius is far below script's, and
 * script-src stays strict.
 *
 * Nothing is loaded from another origin: connect-src, img-src and font-src
 * are 'self' (plus `data:` / `blob:` where the primitives need them), with ONE
 * exception, below. A new origin is added here, in the change that needs it,
 * never as a wildcard.
 *
 * THE ONE EXCEPTION (decision D20): tldraw's licence manager, unlicensed (we
 * use tldraw 3.x with its watermark and no key, D1), `fetch`es one file from
 * its CDN on an https page: `TLDRAW_WATERMARK_TRACK_URL`. connect-src admits
 * exactly that URL — a source expression with a full path matches that path
 * only — and no other path or directive names the host. The request carries no
 * author text: tldraw learns the page's origin (the Referer, cut to the origin
 * by `Referrer-Policy`) and the visitor's IP address (docs/sub-processors.md).
 * `tests/unit/security/csp.test.ts` derives the URL from the installed
 * @tldraw/editor, so a tldraw release that moves it fails there.
 * There is no violation-report endpoint yet: a report route is an
 * unauthenticated write, and it arrives with the feature that needs one.
 *
 * Adapted from inflect-compliance's `src/lib/security/csp.ts` (see
 * docs/carve-manifest.md): no Google Fonts, no `https:` wildcard in
 * connect-src or img-src, no report-only mode or report endpoint.
 */

/** The request header that carries the nonce from the proxy to server components. */
export const CSP_NONCE_HEADER = 'x-csp-nonce';

export const CSP_HEADER = 'Content-Security-Policy';

/** A 128-bit nonce, base64. Web Crypto, so the module needs no Node built-in. */
export function generateNonce(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes));
}

const NONCE_SHAPE = /^[A-Za-z0-9+/]{16,64}={0,2}$/;

/**
 * The inline script that sets `__webpack_nonce__`, so every chunk webpack
 * creates at run time carries the nonce (the root layout renders it). The
 * nonce is checked against the shape `generateNonce` produces, so nothing but
 * base64 ever reaches the script; any other value yields no script at all.
 */
export function webpackNonceBridge(nonce: string): string {
    if (!NONCE_SHAPE.test(nonce)) return '';
    const literal = JSON.stringify(nonce);
    return `window.__webpack_nonce__=${literal};globalThis.__webpack_nonce__=${literal};`;
}

/**
 * The one request tldraw makes to its CDN once mounted unlicensed on an https
 * page (`@tldraw/editor`'s LicenseManager: `fetch(<cdn>/<version>/watermarks/
 * watermark-track.svg)`), so connect-src. The version is @tldraw/editor's own.
 */
export const TLDRAW_WATERMARK_TRACK_URL = 'https://cdn.tldraw.com/3.15.6/watermarks/watermark-track.svg';

type Directives = Record<string, readonly string[] | true>;

function serialize(directives: Directives): string {
    return Object.entries(directives)
        .map(([name, value]) => (value === true ? name : `${name} ${value.join(' ')}`))
        .join('; ');
}

/** The policy for one request. */
export function buildCspHeader(nonce: string, isDev = false): string {
    const directives: Directives = {
        'default-src': ["'self'"],
        'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'", TLDRAW_WATERMARK_TRACK_URL, ...(isDev ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : [])],
        'worker-src': ["'self'", 'blob:'],
        'manifest-src': ["'self'"],
        'media-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
    };
    if (!isDev) directives['upgrade-insecure-requests'] = true;
    return serialize(directives);
}

/**
 * The policy a static asset carries (`/_next/static/**`, set by
 * next.config.mjs): nothing it could become as a document may load anything.
 * Browsers ignore a CSP on a script or stylesheet they load as a subresource,
 * so this binds only an asset opened as a page.
 */
export const STATIC_ASSET_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * The headers every response carries, besides the policy. next.config.mjs
 * repeats this list for the static assets (it cannot import a TypeScript
 * module at run time); tests/e2e/security-headers.spec.ts checks both copies
 * against this one on real responses.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * HSTS, production only: development serves plain http on localhost, where a
 * cached max-age would break every other local port.
 */
export const HSTS_HEADER = { name: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' } as const;

/** Stamp the security headers and `csp` on `headers`. */
export function applySecurityHeaders(headers: Headers, csp: string, isProduction: boolean): void {
    headers.set(CSP_HEADER, csp);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    if (isProduction) headers.set(HSTS_HEADER.name, HSTS_HEADER.value);
}
