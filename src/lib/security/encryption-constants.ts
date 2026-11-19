/**
 * The development fallback for `DATA_ENCRYPTION_KEY`, in a leaf module so the
 * env schema (`src/env.ts`), the startup checks (`src/lib/startup-checks.ts`)
 * and the encryption runtime (`./encryption.ts`) compare against one string
 * without importing each other.
 *
 * NEVER acceptable in production: the env schema and the startup checks
 * both refuse a production process whose key is missing, shorter than 32
 * characters, or equal to this value. Its security property is "well-known
 * and refused in production", not "secret".
 *
 * Lifted from inflect-compliance's `src/lib/security/encryption-constants.ts`
 * (see docs/carve-manifest.md); the value is Inkquisitor's own.
 */
export const DEV_FALLBACK_DATA_ENCRYPTION_KEY = 'inkquisitor-dev-encryption-key-not-for-production-use!!';

/** The shortest master key a production process accepts. */
export const MIN_DATA_ENCRYPTION_KEY_LENGTH = 32;
