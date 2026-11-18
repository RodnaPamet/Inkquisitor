import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '@/lib/product';
// The theme constants come from the SERVER-SAFE module, never from
// ThemeProvider ('use client'), whose exports reach a server component as
// client-reference proxies rather than their string values.
import { THEME_COOKIE, THEME_INIT_SCRIPT, type Theme } from '@/lib/theme-constants';
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
 * localStorage → `prefers-color-scheme` before first paint otherwise. The CSP
 * nonce plumbing inflect carries arrives with the CSP in Phase 0.H.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
    const locale = await getLocale();
    const messages = await getMessages();
    const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
    const initialTheme: Theme = cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : 'dark';

    return (
        <html lang={locale} data-theme={initialTheme} suppressHydrationWarning>
            <head>
                <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
            </head>
            <body className="min-h-screen antialiased" suppressHydrationWarning>
                <NextIntlClientProvider messages={messages} locale={locale}>
                    <Providers>{children}</Providers>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}
