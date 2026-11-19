/**
 * The secret next-auth signs and encrypts the session JWT with, read by both
 * the auth configuration (`src/auth.ts`) and the edge middleware's
 * `getToken`, so the two can never disagree.
 *
 * REQUIRED in production: `src/lib/startup-checks.ts` refuses a production
 * process without AUTH_SECRET (at least 32 characters, never the fallback
 * below), and the env schema repeats the rule. Development and test use the
 * documented fallback, whose security property is "well-known and refused in
 * production", not "secret". `next build` runs as production with no runtime
 * secrets and signs nothing, so it reads the fallback rather than throwing at
 * module load; the server it builds is checked when it starts.
 *
 * Edge-safe: no Node import.
 */
import { env } from '@/env';
import { isNextProductionBuild } from '@/lib/build-phase';
import { DEV_FALLBACK_AUTH_SECRET } from './auth-constants';

export { DEV_FALLBACK_AUTH_SECRET };

export function authSecret(): string {
    const secret = env.AUTH_SECRET;
    if (secret) return secret;
    if (env.NODE_ENV === 'production' && !isNextProductionBuild(process.env)) {
        throw new Error('AUTH_SECRET is required in production (see src/lib/startup-checks.ts).');
    }
    return DEV_FALLBACK_AUTH_SECRET;
}
