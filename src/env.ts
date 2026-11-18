import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * THE SERVER-SIDE ENVIRONMENT.
 *
 * Every server variable the application reads is declared here, and code
 * reads `env.X`, never `process.env.X`. A variable is added in the same
 * change as the first code that reads it — this skeleton reads two.
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
 */
export const env = createEnv({
    server: {
        NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
        // The runtime connection (PgBouncer, transaction mode, in the compose
        // stack). Read by src/lib/db.ts. The Prisma CLI reads it, and
        // DIRECT_DATABASE_URL, through prisma.config.ts instead.
        DATABASE_URL: z.string().url(),
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
