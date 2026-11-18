import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';
import { isNextProductionBuild } from '@/lib/build-phase';

/**
 * THE SERVER-SIDE ENVIRONMENT.
 *
 * Every server variable the application reads is declared here, and code
 * reads `env.X`, never `process.env.X`. A variable is added in the same
 * change as the first code that reads it.
 *
 * NEVER import this module from a `'use client'` file. A server variable's
 * VALUE never reaches a browser (t3-env throws on a server key read on the
 * client), but its SCHEMA is ordinary module code, so anything `next build`
 * bundles for the client would carry every key name in this file. Client
 * code imports `@/env-client`, which holds the `NEXT_PUBLIC_` variables.
 * `tests/guards/client-modules-import-no-server-env.test.ts` holds this.
 *
 * Every variable read here is listed in `.env.example`;
 * `tests/unit/env-example.test.ts` fails when one is missing.
 *
 * ── Defaults (Phase 0.4) ────────────────────────────────────────────
 *
 * Every platform-service variable is OPTIONAL with a safe development
 * default, so `npm run dev` works with nothing but `DATABASE_URL`. The
 * defaults that point at infrastructure (the local Redis, the local file
 * store) live beside the code that uses them, not here, because PRODUCTION
 * must not inherit them: `src/lib/startup-checks.ts` lists what production
 * requires, and both the web tier (`src/instrumentation.ts`) and the worker
 * (`scripts/worker.ts`) refuse to start while any of it is missing. The
 * schema below repeats the REDIS_URL rule so a production process with
 * validation on fails at module load, before the hook runs.
 */
export const env = createEnv({
    server: {
        NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
        // The runtime connection (PgBouncer, transaction mode, in the compose
        // stack). Read by src/lib/db.ts. The Prisma CLI reads it, and
        // DIRECT_DATABASE_URL, through prisma.config.ts instead.
        DATABASE_URL: z.string().url(),

        // ── Public URL ──
        // The canonical origin the product is reached on (https://app.example).
        // Read by src/lib/http/public-base-url.ts: a URL handed to somebody
        // outside the process is built from this, never from the request's
        // Host header (ESLint `local/no-request-derived-public-url`).
        APP_URL: z.string().url().optional(),

        // ── Logging ──
        LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).optional(),

        // ── OpenTelemetry (off unless OTEL_ENABLED=true) ──
        OTEL_ENABLED: z.enum(['true', 'false']).optional(),
        OTEL_SERVICE_NAME: z.string().min(1).optional(),
        OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

        // ── Sentry (off unless SENTRY_DSN is set) ──
        SENTRY_DSN: z.string().url().optional(),
        SENTRY_ENVIRONMENT: z.string().min(1).optional(),
        SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),

        // ── Redis (rate limits, BullMQ) ──
        // Optional in development (src/lib/redis.ts falls back to the local
        // compose Redis); REQUIRED and AUTHENTICATED in production.
        REDIS_URL: z
            .string()
            .optional()
            .superRefine((val, ctx) => {
                if (process.env.NODE_ENV !== 'production') return;
                // `next build` runs as production and imports every route
                // module; the secret exists only at run time. The running
                // server still enforces this rule (see src/lib/build-phase.ts).
                if (isNextProductionBuild(process.env)) return;
                if (!val) {
                    ctx.addIssue({
                        code: 'custom',
                        message:
                            'REDIS_URL is REQUIRED in production: rate limits and the job queue live there. ' +
                            'Set it to redis://:PASSWORD@HOST:6379 (or rediss:// for TLS).',
                    });
                    return;
                }
                let url: URL;
                try {
                    url = new URL(val);
                } catch {
                    ctx.addIssue({ code: 'custom', message: 'REDIS_URL is not a valid URL.' });
                    return;
                }
                if (!url.password) {
                    ctx.addIssue({
                        code: 'custom',
                        message:
                            'REDIS_URL must be AUTHENTICATED in production (redis://:PASSWORD@HOST:6379): ' +
                            'an open Redis exposes every rate-limit counter and every queued job.',
                    });
                }
            }),

        // ── Rate limiting ──
        // RATE_LIMIT_ENABLED=0 switches every tier off for the process.
        // RATE_LIMIT_MODE=memory forces the in-process store even when Upstash
        // is configured; otherwise Upstash is used exactly when both
        // UPSTASH_REDIS_REST_* variables are set, and memory when they are not.
        RATE_LIMIT_ENABLED: z.enum(['0', '1']).optional(),
        RATE_LIMIT_MODE: z.enum(['upstash', 'memory']).optional(),
        UPSTASH_REDIS_REST_URL: z.string().url().optional(),
        UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

        // ── File storage ──
        // `local` (the default) writes under FILE_STORAGE_ROOT; `s3` talks to
        // any S3-compatible endpoint and needs S3_BUCKET.
        STORAGE_PROVIDER: z.enum(['local', 's3']).optional(),
        FILE_STORAGE_ROOT: z.string().min(1).optional(),
        FILE_MAX_SIZE_BYTES: z.coerce.number().int().positive().optional(),
        FILE_ALLOWED_MIME: z.string().min(1).optional(),
        S3_BUCKET: z.string().min(1).optional(),
        S3_REGION: z.string().min(1).optional(),
        S3_ENDPOINT: z.string().url().optional(),
        S3_ACCESS_KEY_ID: z.string().min(1).optional(),
        S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),

        // ── Antivirus scanning (ClamAV clamd over TCP) ──
        AV_SCAN_MODE: z.enum(['strict', 'permissive', 'disabled']).optional(),
        CLAMAV_HOST: z.string().min(1).optional(),

        // ── Mail (console sink when SMTP_HOST is unset) ──
        SMTP_HOST: z.string().min(1).optional(),
        SMTP_PORT: z.coerce.number().int().positive().optional(),
        SMTP_USER: z.string().min(1).optional(),
        SMTP_PASS: z.string().min(1).optional(),
        SMTP_FROM: z.string().min(1).optional(),
    },

    /**
     * Client variables live in src/env-client.ts. This module declares none.
     */
    client: {},

    /**
     * Destructured by hand: process.env cannot be spread in the edge runtime.
     */
    runtimeEnv: {
        NODE_ENV: process.env.NODE_ENV,
        DATABASE_URL: process.env.DATABASE_URL,
        APP_URL: process.env.APP_URL,
        LOG_LEVEL: process.env.LOG_LEVEL,
        OTEL_ENABLED: process.env.OTEL_ENABLED,
        OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        SENTRY_DSN: process.env.SENTRY_DSN,
        SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
        SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE,
        REDIS_URL: process.env.REDIS_URL,
        RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
        RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
        UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
        STORAGE_PROVIDER: process.env.STORAGE_PROVIDER,
        FILE_STORAGE_ROOT: process.env.FILE_STORAGE_ROOT,
        FILE_MAX_SIZE_BYTES: process.env.FILE_MAX_SIZE_BYTES,
        FILE_ALLOWED_MIME: process.env.FILE_ALLOWED_MIME,
        S3_BUCKET: process.env.S3_BUCKET,
        S3_REGION: process.env.S3_REGION,
        S3_ENDPOINT: process.env.S3_ENDPOINT,
        S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
        S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
        AV_SCAN_MODE: process.env.AV_SCAN_MODE,
        CLAMAV_HOST: process.env.CLAMAV_HOST,
        SMTP_HOST: process.env.SMTP_HOST,
        SMTP_PORT: process.env.SMTP_PORT,
        SMTP_USER: process.env.SMTP_USER,
        SMTP_PASS: process.env.SMTP_PASS,
        SMTP_FROM: process.env.SMTP_FROM,
    },

    /**
     * `SKIP_ENV_VALIDATION=1` skips validation. Used by `next build` in CI and
     * the Docker builder, where the real values are provided at run time, and
     * by Jest.
     */
    skipValidation: !!process.env.SKIP_ENV_VALIDATION,

    /**
     * Compose and shell defaults produce empty strings rather than absent
     * variables (`"${VAR:-}"`), so an empty value is treated as unset.
     */
    emptyStringAsUndefined: true,
});
