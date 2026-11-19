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
 * Maximum length, in UTF-8 BYTES: bcrypt reads at most 72 bytes of its input
 * and silently ignores the rest, so a longer password is refused rather than
 * truncated. The password reaches bcrypt as it is (no pre-hash: a fast digest
 * of a password is what CodeQL's js/insufficient-password-hash flags, and a
 * stored hash never has to be migrated off one). 72 bytes is 72 ASCII
 * characters, or fewer in scripts that take more than one byte per character.
 */
export const MAX_PASSWORD_BYTES = 72;

/** Character cap for form inputs; the byte limit above is the real rule. */
export const MAX_PASSWORD_LENGTH = MAX_PASSWORD_BYTES;

/** UTF-8 byte length, client-safe (no Buffer). */
export function passwordByteLength(plaintext: string): number {
    return new TextEncoder().encode(plaintext).length;
}
