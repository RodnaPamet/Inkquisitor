/**
 * Locale constants — SERVER-SAFE.
 *
 * Lifted from inflect-compliance's `src/lib/locale-constants.ts` (see
 * docs/carve-manifest.md). This module MUST NOT carry a `'use client'`
 * directive and MUST NOT import a client-only module: the next-intl request
 * config (`src/i18n.ts`) and the root layout's `<html lang>` read it on the
 * server, and a value imported from a `'use client'` module arrives there as
 * a client-reference proxy rather than the string.
 *
 * The UI locale is a per-browser preference persisted in a first-party
 * cookie, read server-side in `getRequestConfig` so the first SSR byte is in
 * the chosen language. Inkquisitor ships English only (inflect also ships
 * Bulgarian), so the cookie resolves to `en` whatever it says; adding a
 * locale is adding it to `SUPPORTED_LOCALES` and a `messages/<locale>.json`.
 */

/** Every locale the UI ships a message catalog for (`messages/<locale>.json`). */
export const SUPPORTED_LOCALES = ['en'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Fallback when no cookie is set or the cookie value is unrecognised. */
export const DEFAULT_LOCALE: Locale = 'en';

/** Cookie name — RFC6265 token, matching the theme cookie's convention. */
export const LOCALE_COOKIE = 'inkquisitor_locale';

/** Type guard: is `value` one of the supported locales? */
export function isSupportedLocale(value: unknown): value is Locale {
    return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Coerce an arbitrary cookie/input value to a supported locale (default fallback). */
export function resolveLocale(value: unknown): Locale {
    return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}
