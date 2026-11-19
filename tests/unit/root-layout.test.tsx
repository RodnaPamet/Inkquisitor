/**
 * The root layout seeds `<html data-theme>` from the theme cookie and
 * `<html lang>` from next-intl.
 *
 * Flash-proofing depends on the SERVER rendering the chosen theme: the theme
 * cookie (`inkquisitor_theme`) is read in the layout and only `light` or
 * `dark` is trusted; anything else, or no cookie, renders the dark baseline
 * (the pre-paint script then follows the OS). The defect this guards is the
 * one src/lib/theme-constants.ts describes: the cookie silently missed, so
 * SSR always rendered dark. Ported in spirit from inflect-compliance's
 * tests/unit/theme-provider.test.ts ("layout.tsx seeds data-theme from the
 * persisted theme COOKIE"), rewritten to render the layout.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const cookieValue: { current: string | undefined } = { current: undefined };
const cookieGet = jest.fn((name: string) => (cookieValue.current === undefined ? undefined : { name, value: cookieValue.current }));
const nonceValue: { current: string | null } = { current: null };
jest.mock('next/headers', () => ({
    cookies: async () => ({ get: cookieGet }),
    headers: async () => new Headers(nonceValue.current ? { 'x-csp-nonce': nonceValue.current } : {}),
}));
const getLocale = jest.fn(async () => 'en');
jest.mock('next-intl/server', () => ({ getLocale: () => getLocale(), getMessages: async () => ({}) }));
// The client providers are not under test here.
jest.mock('@/app/providers', () => ({ Providers: ({ children }: { children: ReactNode }) => children }));

import RootLayout from '@/app/layout';
import { THEME_COOKIE } from '@/lib/theme-constants';

async function htmlTag(): Promise<string> {
    const markup = renderToStaticMarkup(await RootLayout({ children: <p>page</p> }));
    return /<html[^>]*>/.exec(markup)![0];
}

afterEach(() => {
    cookieValue.current = undefined;
    nonceValue.current = null;
    cookieGet.mockClear();
});

describe('root layout', () => {
    it('reads the theme cookie by its real name', async () => {
        await htmlTag();
        expect(cookieGet).toHaveBeenCalledWith(THEME_COOKIE);
        expect(THEME_COOKIE).toBe('inkquisitor_theme');
    });

    it.each(['light', 'dark'])('renders data-theme="%s" from the cookie', async (theme) => {
        cookieValue.current = theme;
        expect(await htmlTag()).toContain(`data-theme="${theme}"`);
    });

    it.each([undefined, 'sepia', '', 'LIGHT'])('renders the dark baseline for cookie %p', async (value) => {
        cookieValue.current = value;
        expect(await htmlTag()).toContain('data-theme="dark"');
    });

    it('takes lang from next-intl', async () => {
        getLocale.mockResolvedValueOnce('en');
        expect(await htmlTag()).toContain('lang="en"');
        getLocale.mockResolvedValueOnce('xx-test');
        expect(await htmlTag()).toContain('lang="xx-test"');
    });

    it('renders the page inside the body', async () => {
        const markup = renderToStaticMarkup(await RootLayout({ children: <p>page</p> }));
        expect(markup).toMatch(/<body[^>]*>[\s\S]*<p>page<\/p>[\s\S]*<\/body>/);
    });
});

describe('the CSP nonce', () => {
    const NONCE = 'dGhpcyBpcyBhIG5vbmNlIQ==';

    it('every inline script the layout renders carries the request nonce, and the webpack bridge sets it', async () => {
        nonceValue.current = NONCE;
        const markup = renderToStaticMarkup(await RootLayout({ children: <p>page</p> }));
        const scripts = [...markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
        expect(scripts.length).toBe(2);
        for (const [tag] of scripts) expect(tag).toContain(`nonce="${NONCE}"`);
        expect(markup).toContain(`window.__webpack_nonce__="${NONCE}"`);
    });

    it('without a nonce (no proxy in front) there is no bridge, and nothing claims one', async () => {
        const markup = renderToStaticMarkup(await RootLayout({ children: <p>page</p> }));
        expect(markup).not.toContain('__webpack_nonce__');
        expect(markup).not.toContain('nonce=');
    });
});
