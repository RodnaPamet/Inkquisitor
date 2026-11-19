/**
 * Where a sign-in may send the browser afterwards: a path on this site, or
 * nowhere in particular.
 *
 * Client-safe (no imports): the sign-in page is a client component and needs
 * the same rule as the proxy, which bounces a signed-out visitor to
 * `/login?callbackUrl=…`.
 *
 * Lifted from inflect-compliance's `src/lib/auth/redirect-path.ts` (see
 * docs/carve-manifest.md); `postSignInPath` falls back to `/`, which sends a
 * signed-in person to their first workspace.
 */

/** An origin nothing can be served from, used only to resolve a path. */
const PROBE_ORIGIN = 'https://redirect-path.invalid';

/**
 * A browser treats `\` as `/`, and drops tab, CR and LF from a URL, so
 * `/\evil.com` and `/<TAB>/evil.com` are both `//evil.com` by the time the
 * browser reads them: another host. Any control character is refused with them.
 */
const ESCAPING_CHARS = /[\\\u0000-\u001f\u007f]/;

/**
 * The path, query and fragment of `next` when it is a path on this site;
 * `'/'` for anything else (an absolute or protocol-relative URL, a
 * `javascript:` URL, a relative path, any path a browser would read as
 * another host). Decoded once first, so an encoded escape is judged by what
 * it decodes to.
 */
export function sanitizeRedirectPath(next: string | null | undefined): string {
    if (!next) return '/';
    let decoded: string;
    try {
        decoded = decodeURIComponent(next);
    } catch {
        return '/';
    }
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/';
    if (decoded.includes('://') || ESCAPING_CHARS.test(decoded)) return '/';
    let url: URL;
    try {
        url = new URL(decoded, PROBE_ORIGIN);
    } catch {
        return '/';
    }
    if (url.origin !== PROBE_ORIGIN) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
}

/** Where the sign-in page sends the browser once someone has signed in. */
export function postSignInPath(requested: string | null | undefined): string {
    return sanitizeRedirectPath(requested);
}
