/**
 * The development fallback for `AUTH_SECRET`, in a leaf module so the env
 * schema, the start-up checks and the runtime (`./auth-secret.ts`) compare
 * against one string without importing each other. Refused in production by
 * both the env schema and `src/lib/startup-checks.ts`.
 */
// The well-known development value, refused in production. pragma: allowlist secret
export const DEV_FALLBACK_AUTH_SECRET = 'inkquisitor-dev-auth-secret-not-for-production-use!!'; // pragma: allowlist secret

/** The shortest AUTH_SECRET production accepts. */
export const MIN_AUTH_SECRET_LENGTH = 32;
