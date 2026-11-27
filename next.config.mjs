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
 * refuses. PDFKit (Phase 1.3) and fontkit (#24), which embeds the PDF's font,
 * are loaded as published.
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
 * THE LAYOUT WORKER IS ONE CHUNK (Phase 3.H). The story map lays itself out
 * in a Web Worker (`src/lib/canvas/auto-layout-worker.ts`, named
 * `LAYOUT_WORKER_CHUNK` by its constructor), and a worker's script runs under
 * the policy its OWN response carries — the static assets' `default-src
 * 'none'` above — so it may load no other script. Next's client chunking
 * splits modules a worker shares with the page (dagre, which the main thread
 * keeps as the fallback) into a chunk the worker would `importScripts`; the
 * worker's chunk is therefore left out of that splitting, whole.
 * `scripts/check-build.js` fails a build where it is not.
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

/** The layout worker's chunk name: its constructor's `name` (src/lib/canvas/auto-layout-worker-factory.ts). */
const LAYOUT_WORKER_CHUNK = 'story-map-layout';

/** @type {import('next').NextConfig} */
const nextConfig = {
    poweredByHeader: false,
    webpack(config, { isServer }) {
        const split = config.optimization?.splitChunks;
        if (!isServer && split && typeof split === 'object') {
            const chunks = split.chunks;
            const before = (chunk) => (typeof chunks === 'function' ? chunks(chunk) : chunks === 'all' ? true : chunks === 'initial' ? chunk.canBeInitial() : !chunk.canBeInitial());
            split.chunks = (chunk) => chunk.name !== LAYOUT_WORKER_CHUNK && before(chunk);
        }
        return config;
    },
    async headers() {
        return [
            // Exactly the paths src/proxy.ts's matcher skips: something INSIDE
            // /_next/static/ (`:path+`, not `:path*`, so /_next/static itself
            // is the proxy's), and the optimiser's own path.
            { source: '/_next/static/:path+', headers: STATIC_ASSET_HEADERS },
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
        // Phase 1.3: PDFKit, loaded from node_modules as published. Since #24
        // it embeds Noto Sans (read from <cwd>/fonts/noto-sans, which the
        // image copies) through fontkit, which src/lib/pdf/fonts.ts also
        // reads to know what the font covers: external too, so both use the
        // one copy in node_modules.
        'pdfkit',
        'fontkit',
        // Phase 5.H-a: the full export's AES zip writer, loaded as published (its
        // Web Worker and wasm assets are never bundled: it runs with workers off).
        '@zip.js/zip.js',
    ],
};

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

export default withNextIntl(nextConfig);
