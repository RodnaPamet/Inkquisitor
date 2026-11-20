import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';
import { isNextProductionBuild } from '@/lib/build-phase';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY, MIN_DATA_ENCRYPTION_KEY_LENGTH } from '@/lib/security/encryption-constants';
import { DEV_FALLBACK_AUTH_SECRET, MIN_AUTH_SECRET_LENGTH } from '@/lib/auth/auth-constants';
import { ANTHROPIC_WORKSPACE_ID_PATTERN } from '@/lib/ai/anthropic-workspace';

/**
 * A secret production cannot run without. Optional elsewhere (development and
 * test have fallbacks); in a running production process it must be present,
 * at least `min` characters, and not `forbidden` (a documented dev value).
 * `next build` runs as production with no runtime secrets and is exempt; the
 * server it builds is checked when it starts (src/lib/startup-checks.ts).
 */
function productionSecret(name: string, min: number, forbidden?: string) {
    return z
        .string()
        .optional()
        .superRefine((val, ctx) => {
            if (process.env.NODE_ENV !== 'production' || isNextProductionBuild(process.env)) return;
            if (!val || val.length < min) {
                ctx.addIssue({ code: 'custom', message: `${name} is REQUIRED in production (at least ${min} characters).` });
            } else if (forbidden !== undefined && val === forbidden) {
                ctx.addIssue({ code: 'custom', message: `${name} is the documented development fallback; set a real one.` });
            }
        });
}

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
 * `tests/guards/client-reachable-modules-import-no-server-env.test.ts` holds
 * this over the whole client import graph, and `scripts/check-build.js` over
 * the built client chunks.
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

        // ── Authentication (Phase 0.3) ──
        // Signs and encrypts the session JWT (next-auth). REQUIRED in production.
        AUTH_SECRET: productionSecret('AUTH_SECRET', MIN_AUTH_SECRET_LENGTH, DEV_FALLBACK_AUTH_SECRET),
        // The canonical origin next-auth builds its callback URLs on. REQUIRED
        // in production (startup-checks); next-auth also reads it itself.
        NEXTAUTH_URL: z.string().url().optional(),
        // Google sign-in. Both or neither: the provider (and its button) exists
        // only when both are set.
        GOOGLE_CLIENT_ID: z.string().min(1).optional(),
        GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
        // The breached-password check at sign-up (HIBP range API, k-anonymity,
        // fail-open). `off` skips the network call: an air-gapped install, and
        // the end-to-end suite, which calls no outside service.
        PASSWORD_BREACH_CHECK: z.enum(['on', 'off']).optional(),

        // ── Field encryption (Phase 0.3) ──
        // The master key-encryption key: wraps every workspace's data key.
        // REQUIRED in production, at least 32 characters and never the
        // development fallback (src/lib/security/encryption-constants.ts).
        DATA_ENCRYPTION_KEY: productionSecret(
            'DATA_ENCRYPTION_KEY',
            MIN_DATA_ENCRYPTION_KEY_LENGTH,
            DEV_FALLBACK_DATA_ENCRYPTION_KEY,
        ),

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
        // How many reverse proxies in front of this process append to
        // X-Forwarded-For (production: one, Caddy on our own VM). The client
        // address is the entry this many positions from the RIGHT; anything to
        // its left is whatever the client sent. 0 trusts no forwarded header.
        // Read in one place: src/lib/http/client-ip.ts.
        TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

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

        // ── Embeddings (subphase 2.0; read in src/lib/ai/embeddings/select.ts) ──
        // `stub` (the development and test default: deterministic feature
        // hashing, no network) or `tei` (Hugging Face Text Embeddings
        // Inference, self-hosted inside the deployment, so author text reaches
        // no new sub-processor). Production refuses `stub` at start-up and has
        // no embedding provider while this is unset.
        EMBEDDING_PROVIDER: z.enum(['stub', 'tei']).optional(),
        EMBEDDING_TEI_BASE_URL: z.string().url().optional(),
        EMBEDDING_TEI_MODEL: z.string().min(1).max(100).optional(),
        EMBEDDING_TEI_DIMENSIONS: z.string().regex(/^\d+$/).optional(),
        EMBEDDING_TEI_QUERY_PREFIX: z.string().max(200).optional(),
        EMBEDDING_TEI_PASSAGE_PREFIX: z.string().max(200).optional(),
        /** Deduplication's cosine thresholds per embedding revision, `<revision>=<same>,<other>[;…]` (issue #32 item 1; `src/lib/interview/dedupe-thresholds.ts`). */
        DEDUPE_COSINE_THRESHOLDS: z
            .string()
            .regex(/^[^=;\s]{1,200}=(0(\.\d+)?|1(\.0+)?),(0(\.\d+)?|1(\.0+)?)(;[^=;\s]{1,200}=(0(\.\d+)?|1(\.0+)?),(0(\.\d+)?|1(\.0+)?))*$/)
            .optional(),

        // ── The model layer (Phase 2.1; src/lib/ai/config.ts, src/lib/ai/tiers.ts) ──
        // The Anthropic API key. Optional outside production: without it every
        // model call is refused (CREDENTIAL_NOT_CONFIGURED). Production
        // requires it unless AI_DISABLED=1 (src/lib/ai/config.ts). Read ONLY
        // by src/lib/ai/client.ts (`clientForRun`).
        ANTHROPIC_API_KEY: z.string().min(1).optional(),
        // The operator's declaration of how the key's Anthropic organization
        // retains what it is sent (decision D5, amended 2026-11-19): `zdr`
        // (a zero-data-retention arrangement) or `standard-beta` (Anthropic's
        // standard retention, permitted during the closed beta only; a WARN
        // at every start). Production refuses to start holding a key with no
        // declared mode.
        AI_RETENTION_MODE: z.enum(['zdr', 'standard-beta']).optional(),
        // The 2.1 spelling of `AI_RETENTION_MODE=zdr`, still honoured: `1`
        // states the key's organization has a zero-data-retention arrangement.
        ANTHROPIC_ZDR_CONFIRMED: z.enum(['0', '1']).optional(),
        // The Anthropic workspace an ORGANISATION-level key's requests belong
        // to (Phase 2.3, lifted from inflect): sent as `anthropic-workspace-id`
        // by `clientForRun` when set; a workspace-scoped key needs none.
        ANTHROPIC_WORKSPACE_ID: z.string().trim().regex(ANTHROPIC_WORKSPACE_ID_PATTERN, 'ANTHROPIC_WORKSPACE_ID is an Anthropic workspace id (letters, digits, _ and -)').optional(),
        // Read by the SDK itself and merged into every request; declared so
        // the model layer can refuse to build a client while it is set.
        ANTHROPIC_CUSTOM_HEADERS: z.string().optional(),
        // The global kill switch: `1` refuses every model call (KILLED).
        AI_DISABLED: z.enum(['0', '1']).optional(),
        // The in-process stubbed model (Phase 2.4, src/lib/ai/model-stub.ts):
        // `1` answers every model call with canned questions, for a local test
        // server. Production refuses it unless APP_URL and NEXTAUTH_URL are
        // both loopback, and with ANTHROPIC_API_KEY set.
        AI_MODEL_STUB: z.enum(['0', '1']).optional(),
        // Each workspace's model spend ceiling per UTC calendar month, in US
        // dollars (default 50, decision D10). The worst case of a call is checked against it
        // before the call is sent.
        AI_MONTHLY_CEILING_USD_DEFAULT: z
            .string()
            .regex(/^\d+(\.\d{1,6})?$/)
            .optional(),
        // How long a model call's AiCallLog row is kept, in days (Phase 2.H,
        // issue #30 item 4): default 400, at least 365 (the database refuses
        // younger deletes whatever this says). src/lib/ai/call-log-retention.ts.
        AI_CALL_LOG_RETENTION_DAYS: z.string().regex(/^\d{1,5}$/).optional(),
        // Override the model a tier runs on (defaults: claude-haiku-5-5,
        // claude-sonnet-5-5, claude-opus-5-5).
        AI_MODEL_FAST: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,99}$/).optional(),
        AI_MODEL_BALANCED: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,99}$/).optional(),
        AI_MODEL_DEEP: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,99}$/).optional(),

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
        AUTH_SECRET: process.env.AUTH_SECRET,
        NEXTAUTH_URL: process.env.NEXTAUTH_URL,
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
        PASSWORD_BREACH_CHECK: process.env.PASSWORD_BREACH_CHECK,
        DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
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
        TRUSTED_PROXY_HOPS: process.env.TRUSTED_PROXY_HOPS,
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
        EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
        EMBEDDING_TEI_BASE_URL: process.env.EMBEDDING_TEI_BASE_URL,
        EMBEDDING_TEI_MODEL: process.env.EMBEDDING_TEI_MODEL,
        EMBEDDING_TEI_DIMENSIONS: process.env.EMBEDDING_TEI_DIMENSIONS,
        EMBEDDING_TEI_QUERY_PREFIX: process.env.EMBEDDING_TEI_QUERY_PREFIX,
        EMBEDDING_TEI_PASSAGE_PREFIX: process.env.EMBEDDING_TEI_PASSAGE_PREFIX,
        DEDUPE_COSINE_THRESHOLDS: process.env.DEDUPE_COSINE_THRESHOLDS,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        AI_RETENTION_MODE: process.env.AI_RETENTION_MODE,
        ANTHROPIC_ZDR_CONFIRMED: process.env.ANTHROPIC_ZDR_CONFIRMED,
        ANTHROPIC_WORKSPACE_ID: process.env.ANTHROPIC_WORKSPACE_ID,
        ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
        AI_DISABLED: process.env.AI_DISABLED,
        AI_MODEL_STUB: process.env.AI_MODEL_STUB,
        AI_MONTHLY_CEILING_USD_DEFAULT: process.env.AI_MONTHLY_CEILING_USD_DEFAULT,
        AI_CALL_LOG_RETENTION_DAYS: process.env.AI_CALL_LOG_RETENTION_DAYS,
        AI_MODEL_FAST: process.env.AI_MODEL_FAST,
        AI_MODEL_BALANCED: process.env.AI_MODEL_BALANCED,
        AI_MODEL_DEEP: process.env.AI_MODEL_DEEP,
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
