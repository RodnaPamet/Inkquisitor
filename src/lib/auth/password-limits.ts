/**
 * The password length limits, client-safe: no server import, so the sign-up
 * form can check them before it sends. `./passwords.ts` re-exports them and
 * the server enforces them through `validatePasswordPolicy`.
 *
 * Lifted from inflect-compliance's `src/lib/auth/password-limits.ts` (see
 * docs/carve-manifest.md).
 */

/** Minimum length when a password is SET (sign-up). Sign-in does not re-check. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Maximum length, in UTF-16 code units: bounds the work a giant body can cost
 * the sign-in route. It is not a guard against bcrypt's 72-byte truncation —
 * the password is pre-hashed before bcrypt sees it (`prehashForBcrypt`), so
 * nothing is truncated whatever the script or length.
 */
export const MAX_PASSWORD_LENGTH = 128;
