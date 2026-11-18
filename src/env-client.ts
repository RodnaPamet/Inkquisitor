import { createEnv } from '@t3-oss/env-nextjs';

/**
 * THE CLIENT-SIDE ENVIRONMENT, AND THE ONLY ENV MODULE A `'use client'` FILE
 * MAY IMPORT.
 *
 * `src/env.ts` holds the server variables. Their values never reach a
 * browser, but their schema is ordinary module code, so a client component
 * importing `@/env` would put the whole server schema into the client
 * bundle. A client-reachable module that needs a variable adds it HERE,
 * prefixed `NEXT_PUBLIC_` (t3-env enforces the prefix and Next inlines the
 * value at build time).
 *
 * The skeleton reads no client variable, so the schema is empty. The module
 * exists now so the first client variable has a home that is not `@/env`.
 */
export const envClient = createEnv({
    client: {},
    runtimeEnv: {},
    skipValidation: !!process.env.SKIP_ENV_VALIDATION,
    emptyStringAsUndefined: true,
});

export const env = envClient;
