import createNextIntlPlugin from 'next-intl/plugin';

/**
 * Next.js configuration.
 *
 * Plain JavaScript (not next.config.ts) so the runtime image, which prunes
 * dev dependencies, can load it without TypeScript.
 *
 * Security headers (Phase 0.H). The proxy (src/proxy.ts) stamps the
 * content-security policy, with a per-request nonce, and the headers in
 * `SECURITY_HEADERS` (src/lib/security/csp.ts) on every response except the
 * static assets, which it does not run for. `headers()` below gives those
 * assets the same set with a policy of their own (`STATIC_ASSET_CSP`). The
 * list is repeated rather than imported because this file is loaded at run
 * time from an image that carries no TypeScript source;
 * tests/e2e/security-headers.spec.ts checks both copies on real responses.
 *
 * `serverExternalPackages` (Phase 0.4, the list inflect-compliance carries):
 * packages Node loads at run time rather than webpack bundling them, because
 * they use worker_threads, dynamic `require` or optional native modules that
 * do not survive bundling. BullMQ `require`s the optional
 * `@valkey/valkey-glide` inside a try/catch, which Node tolerates and webpack
 * refuses.
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
 */

/** The static assets' headers; `headers()` below. */
const STATIC_ASSET_HEADERS = [
    { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    ...(process.env.NODE_ENV === 'production'
        ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
        : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
    poweredByHeader: false,
    async headers() {
        return [
            { source: '/_next/static/:path*', headers: STATIC_ASSET_HEADERS },
            { source: '/_next/image', headers: STATIC_ASSET_HEADERS },
        ];
    },
    reactStrictMode: true,
    serverExternalPackages: [
        'pino',
        'pino-pretty',
        'thread-stream',
        '@opentelemetry/api',
        '@opentelemetry/resources',
        '@opentelemetry/sdk-trace',
        '@opentelemetry/sdk-metrics',
        '@opentelemetry/exporter-trace-otlp-http',
        '@opentelemetry/exporter-metrics-otlp-http',
        '@opentelemetry/semantic-conventions',
        '@sentry/nextjs',
        '@sentry/node',
        '@aws-sdk/client-s3',
        '@aws-sdk/s3-request-presigner',
        'bullmq',
        'ioredis',
        'nodemailer',
    ],
};

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

export default withNextIntl(nextConfig);
