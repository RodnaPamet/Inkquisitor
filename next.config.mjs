/**
 * Next.js configuration.
 *
 * Plain JavaScript (not next.config.ts) so the runtime image, which prunes
 * dev dependencies, can load it without TypeScript.
 *
 * Security headers and the content-security policy arrive with Phase 0.H.
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
 * @type {import('next').NextConfig}
 */
const nextConfig = {
    poweredByHeader: false,
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

export default nextConfig;
