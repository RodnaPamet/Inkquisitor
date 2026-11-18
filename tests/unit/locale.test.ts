/**
 * The cookie-based UI locale (src/lib/locale-constants.ts, src/i18n.ts).
 *
 * Rules followed from inflect-compliance's
 * tests/guardrails/i18n-locale-infrastructure.test.ts, rewritten as
 * behaviour: `resolveLocale` lets through only a supported locale and falls
 * back to English for anything else (so a tampered cookie can never name the
 * file the request config imports), every supported locale has a catalog that
 * parses, and the request config reads the locale cookie and passes its value
 * through `resolveLocale`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const cookieValue: { current: string | undefined } = { current: undefined };
const cookieGet = jest.fn((name: string) => (cookieValue.current === undefined ? undefined : { name, value: cookieValue.current }));
jest.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
// next-intl/server is ESM-only; `getRequestConfig` only wraps the callback.
jest.mock('next-intl/server', () => ({ getRequestConfig: (fn: unknown) => fn }));

import requestConfig from '@/i18n';
import { DEFAULT_LOCALE, LOCALE_COOKIE, SUPPORTED_LOCALES, isSupportedLocale, resolveLocale } from '@/lib/locale-constants';

type Config = { locale: string; messages: Record<string, unknown> };
const runRequestConfig = requestConfig as unknown as () => Promise<Config>;

describe('resolveLocale', () => {
    it('passes a supported locale through', () => {
        expect(resolveLocale('en')).toBe('en');
    });

    it.each([undefined, null, '', 'xx', '../x', '../messages/en', 'EN', 'en-GB', 42, {}])(
        'falls back to English for %p',
        (value) => {
            expect(resolveLocale(value)).toBe('en');
        },
    );

    it('isSupportedLocale agrees with the list', () => {
        for (const locale of SUPPORTED_LOCALES) expect(isSupportedLocale(locale)).toBe(true);
        expect(isSupportedLocale('xx')).toBe(false);
        expect(isSupportedLocale(undefined)).toBe(false);
        expect(DEFAULT_LOCALE).toBe('en');
    });
});

describe('message catalogs', () => {
    it.each(SUPPORTED_LOCALES.map((l) => [l]))('messages/%s.json exists and parses to an object', (locale) => {
        const file = path.resolve(__dirname, '../../messages', `${locale}.json`);
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(parsed).toEqual(expect.any(Object));
        expect(Object.keys(parsed as object).length).toBeGreaterThan(0);
    });
});

describe('the next-intl request config (src/i18n.ts)', () => {
    afterEach(() => {
        cookieValue.current = undefined;
        cookieGet.mockClear();
    });

    it('reads the locale cookie', async () => {
        cookieValue.current = 'en';
        const config = await runRequestConfig();
        expect(cookieGet).toHaveBeenCalledWith(LOCALE_COOKIE);
        expect(LOCALE_COOKIE).toBe('inkquisitor_locale');
        expect(config.locale).toBe('en');
    });

    it.each([undefined, 'xx', '../x', 'EN'])('resolves cookie %p to English and loads its catalog', async (value) => {
        cookieValue.current = value;
        const config = await runRequestConfig();
        expect(config.locale).toBe('en');
        const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../messages/en.json'), 'utf8'));
        expect(config.messages).toEqual(en);
    });
});
