/**
 * THE ONE VALUE A DOWNSTREAM PRODUCT CHANGES.
 *
 * Every UI preference this app persists — theme, view mode, filter presets, the
 * palette's recents, the previous path — is namespaced by a single prefix. That
 * prefix lives here, once, so a product that vendors these files byte-identical
 * changes one constant rather than carrying a diff at every call site.
 *
 * ## Why a seam and not a find-and-replace
 *
 * These keys were spelled inline at each site, and the cost was not cosmetic:
 * `ThemeProvider` built a cookie-matching regex from the literal `'inkquisitor_theme'`
 * rather than from `THEME_COOKIE`, so the constant and the reader could drift and
 * once did. A single helper means the writer and the reader cannot disagree about
 * a key, because there is only one expression that produces it.
 *
 * ## The prefix
 *
 * `UI_STORAGE_PREFIX` is `'inkquisitor'` (inflect's is `'inflect'`). Once
 * shipped it must not change: these keys address data sitting in users'
 * browsers, and a changed key is not a migration, it is a silent reset of
 * everyone's theme, view modes and saved filters.
 *
 * ## What is deliberately NOT routed through here
 *
 * Server-side and infrastructure namespaces (caches, job queues, auth
 * cookies) that merely share the word: none is a UI preference.
 */

/**
 * The namespace every UI preference key carries.
 *
 * A downstream product changes THIS and nothing else. Keep it free of `:` and
 * `=` so `uiCookieName` stays a valid RFC 6265 token.
 */
export const UI_STORAGE_PREFIX = 'inkquisitor';

/**
 * A `localStorage` / `sessionStorage` key: the prefix and each part joined by `:`.
 *
 * `uiStorageKey('theme')` → `'inkquisitor:theme'`
 * `uiStorageKey('view-mode', page)` → `'inkquisitor:view-mode:<page>'`
 *
 * Empty and nullish parts are dropped, so a caller threading an optional segment
 * does not produce a key with an empty slot (`'inflect::theme'`) that would read
 * as a different key from the one it meant.
 */
export function uiStorageKey(...parts: Array<string | null | undefined>): string {
    return [UI_STORAGE_PREFIX, ...parts.filter((p): p is string => !!p && p.length > 0)].join(':');
}

/**
 * A cookie name: the prefix and the name joined by `_`.
 *
 * `uiCookieName('theme')` → `'inkquisitor_theme'`
 *
 * Underscore rather than `:` because a cookie name must be an RFC 6265 token and
 * `:` is a separator there — the same reason `LOCALE_COOKIE` spells itself
 * `inflect_locale` while the storage keys use colons.
 */
export function uiCookieName(name: string): string {
    return `${UI_STORAGE_PREFIX}_${name}`;
}
