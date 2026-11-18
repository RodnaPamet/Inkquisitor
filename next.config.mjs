import createNextIntlPlugin from 'next-intl/plugin';

/**
 * Next.js configuration.
 *
 * Plain JavaScript (not next.config.ts) so the runtime image, which prunes
 * dev dependencies, can load it without TypeScript.
 *
 * Kept deliberately small for the skeleton (Phase 0.1). Security headers and
 * the content-security policy arrive with Phase 0.H; `serverExternalPackages`
 * grows when pino, OpenTelemetry, Sentry and BullMQ land in Phase 0.4.
 *
 * `next build` runs with `--webpack` (see package.json), not Next 16's default
 * Turbopack, matching inflect-compliance: the strict CSP that Phase 0.H adds
 * needs the bundler runtime to put the nonce on every dynamically loaded
 * chunk, which webpack does and Turbopack does not.
 *
 * next-intl (Phase 0.2) is wired through its plugin, which aliases the
 * request config at src/i18n.ts. The locale lives in a cookie, not the URL,
 * so there is no i18n routing.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
    poweredByHeader: false,
    reactStrictMode: true,
};

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

export default withNextIntl(nextConfig);
