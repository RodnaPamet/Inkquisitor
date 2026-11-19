// The root layout reads the locale and messages through next-intl's server
// entry (ESM-only) and the theme cookie through next/headers; this suite
// reads the layout's static metadata and renders the home page, so both are
// stubbed, and the session is the context module's (mocked per test).
import messages from '../../messages/en.json';

jest.mock('next-intl/server', () => ({
    getLocale: async () => 'en',
    getMessages: async () => ({}),
    getTranslations: async (ns: string) => (key: string) =>
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use imports
        (require('../../messages/en.json') as Record<string, Record<string, string>>)[ns][key],
}));
jest.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
jest.mock('next/navigation', () => ({
    redirect: (to: string) => {
        throw Object.assign(new Error('NEXT_REDIRECT'), { to });
    },
}));
const session = { user: null as null | { userId: string; email: string; name: string | null }, slug: null as string | null };
jest.mock('@/app-layer/context', () => ({
    getSessionUser: async () => session.user,
    firstWorkspaceSlug: async () => session.slug,
}));

import { renderToStaticMarkup } from 'react-dom/server';
import HomePage from '@/app/page';
import { metadata } from '@/app/layout';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '@/lib/product';

async function redirectOf(): Promise<string> {
    try {
        await HomePage();
    } catch (err) {
        return (err as { to: string }).to;
    }
    throw new Error('expected a redirect');
}

describe('home page, signed out', () => {
    let html = '';
    beforeAll(async () => {
        session.user = null;
        html = renderToStaticMarkup(await HomePage());
    });

    it('renders the product name as the page heading', () => {
        expect(html).toMatch(/<h1[^>]*>Inkquisitor<\/h1>/);
        expect(PRODUCT_NAME).toBe('Inkquisitor');
    });

    it('renders the one-line description', () => {
        expect(PRODUCT_DESCRIPTION.length).toBeGreaterThan(0);
        expect(html).toContain(`>${PRODUCT_DESCRIPTION}</p>`);
    });

    it('links to sign in and sign up', () => {
        expect(html).toMatch(new RegExp(`<a [^>]*href="/login"[^>]*>${messages.home.signIn}</a>`));
        expect(html).toMatch(new RegExp(`<a [^>]*href="/signup"[^>]*>${messages.home.signUp}</a>`));
    });

    // Class names only: whether Tailwind generates CSS for them is
    // tests/unit/tailwind-pipeline.test.ts.
    it('puts the Tailwind utility classes on the heading', () => {
        expect(html).toMatch(/<h1 class="[^"]*\btext-5xl\b[^"]*\bfont-bold\b/);
    });

    it('names the product in the document metadata', () => {
        expect(metadata.title).toBe(PRODUCT_NAME);
        expect(metadata.description).toBe(PRODUCT_DESCRIPTION);
    });
});

describe('home page, signed in', () => {
    beforeEach(() => {
        session.user = { userId: 'user_1', email: 'ada@example.test', name: 'Ada' };
    });

    it('goes to the first workspace', async () => {
        session.slug = 'adas-desk';
        expect(await redirectOf()).toBe('/w/adas-desk');
    });

    it('goes to /no-workspace when the person belongs to none', async () => {
        session.slug = null;
        expect(await redirectOf()).toBe('/no-workspace');
    });
});
