import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '@/lib/product';
// The theme constants come from the SERVER-SAFE module, never from
// ThemeProvider ('use client'), whose exports reach a server component as
// client-reference proxies rather than their string values.
import { THEME_COOKIE, THEME_INIT_SCRIPT, type Theme } from '@/lib/theme-constants';
import { CSP_NONCE_HEADER, webpackNonceBridge } from '@/lib/security/csp';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
    title: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
};

/**
 * Explicit viewport: Next does not emit a default viewport meta.
 * `maximumScale: 5` keeps pinch-zoom available, an accessibility
 * requirement.
 */
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 5,
};

/**
 * The root layout. Adapted from inflect-compliance's (see
 * docs/carve-manifest.md): the locale and messages come from next-intl's
 * request config (`src/i18n.ts`, cookie-based, no URL routing), and the theme
 * is flash-proof — `data-theme` is rendered from the theme cookie when the
 * user has chosen one, and the pre-paint script resolves cookie →
 * localStorage → `prefers-color-scheme` before first paint otherwise.
 *
 * THE CSP NONCE (Phase 0.H). The proxy puts a fresh nonce on every request
 * (`x-csp-nonce`) and a policy whose script-src admits only scripts carrying
 * it. Next stamps its own `<script>` tags; the two inline scripts here carry it
 * explicitly: the theme script, and the webpack bridge, which sets
 * `__webpack_nonce__` so every chunk webpack loads later is created with the
 * nonce too. `suppressHydrationWarning` on both is load-bearing: a browser
 * hides a nonce attribute from the DOM after applying it, so the client sees
 * `nonce=""` where the server rendered the value. Reading the header makes
 * every page dynamic, which a per-request nonce requires anyway.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
    const locale = await getLocale();
    const messages = await getMessages();
    const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
    const initialTheme: Theme = cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : 'dark';
    const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

    return (
        <html lang={locale} data-theme={initialTheme} suppressHydrationWarning>
            <head>
                <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
                {nonce && (
                    <script
                        nonce={nonce}
                        suppressHydrationWarning
                        dangerouslySetInnerHTML={{ __html: webpackNonceBridge(nonce) }}
                    />
                )}
            </head>
            <body className="min-h-screen antialiased" suppressHydrationWarning>
                <NextIntlClientProvider messages={messages} locale={locale}>
                    <Providers>{children}</Providers>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}
