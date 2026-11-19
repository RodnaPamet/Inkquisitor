/**
 * Password hashing — the ONE place the app hashes or verifies a password.
 * Pure crypto: plaintext and hash in, boolean out. User lookup, lockout,
 * rate limiting and the audit trail live in `./credentials.ts`.
 *
 * bcrypt (the native `bcrypt` package, on libuv's thread pool, off the main
 * thread) at work factor 12, over the password itself. bcrypt reads at most
 * 72 bytes, so a password over `MAX_PASSWORD_BYTES` is refused everywhere
 * (policy, hash, verify) rather than truncated.
 *
 * Lifted from inflect-compliance's `src/lib/auth/passwords.ts` (see
 * docs/carve-manifest.md). Inkquisitor has no legacy hashes, so the
 * two-scheme probe inflect carries for its migration is not: there is one
 * scheme from the first row.
 *
 * Never log a password or a hash.
 */
import { MAX_PASSWORD_BYTES, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordByteLength } from './password-limits';

export { MAX_PASSWORD_BYTES, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordByteLength };

// `bcrypt` is CommonJS. Node's ESM-importing-CJS interop may wrap the exports
// under `.default`; normalise so callers see the module either way. Without
// this, `compare` is undefined under some compilers and every sign-in fails.
const bcryptModule = import('bcrypt').then((m) => (m as unknown as { default?: typeof m }).default ?? m);

/** The bcrypt work factor (OWASP floor for bcrypt is 10). */
export const BCRYPT_COST = 12;

/** True when bcrypt would read the whole password (at most 72 bytes). */
function fitsBcrypt(plaintext: string): boolean {
    return passwordByteLength(plaintext) <= MAX_PASSWORD_BYTES;
}

/** Hash a password for storage. Run `validatePasswordPolicy` first. */
export async function hashPassword(plaintext: string): Promise<string> {
    if (!plaintext) throw new Error('hashPassword: plaintext is empty');
    if (!fitsBcrypt(plaintext)) {
        throw new Error(`hashPassword: plaintext exceeds ${MAX_PASSWORD_BYTES} bytes`);
    }
    const bcrypt = await bcryptModule;
    return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Verify a password against a stored hash. `false` for every failure — empty
 * input, an over-long input, a missing or malformed hash, a wrong password —
 * and every failure costs exactly one bcrypt compare (`dummyVerify` for the
 * cases with nothing to compare against), so the answer's timing does not say
 * which case it was.
 */
export async function verifyPassword(plaintext: string, hash: string | null | undefined): Promise<boolean> {
    if (!plaintext || !hash || !fitsBcrypt(plaintext)) {
        await dummyVerify(plaintext ?? '');
        return false;
    }
    try {
        const bcrypt = await bcryptModule;
        return await bcrypt.compare(plaintext, hash);
    } catch {
        // A malformed stored hash reads as a failed verify; the record's state is not disclosed.
        await dummyVerify(plaintext);
        return false;
    }
}

let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
    // Hashed once, at the current cost, so a dummy compare costs what a real one does.
    dummyHashPromise ??= hashPassword('dummy-placeholder-for-timing-equalisation-do-not-use');
    return dummyHashPromise;
}

/**
 * One bcrypt compare against a placeholder hash, always `false`. Called on
 * every path that has no real hash to compare against (unknown email, a
 * Google-only account, a locked-out identifier) so it takes as long as a
 * wrong password does: response time cannot enumerate accounts.
 */
export async function dummyVerify(plaintext: string): Promise<false> {
    const [bcrypt, hash] = await Promise.all([bcryptModule, getDummyHash()]);
    try {
        // bcrypt reads at most 72 bytes; slicing the string first keeps an
        // over-long input's cost the same as any other compare.
        await bcrypt.compare((plaintext ?? '').slice(0, MAX_PASSWORD_BYTES), hash);
    } catch {
        // Best-effort timing burn.
    }
    return false;
}

/** True when a stored hash was made at a lower cost than `BCRYPT_COST`, or is not bcrypt. */
export function needsRehash(hash: string | null | undefined): boolean {
    if (!hash) return false;
    const match = /^\$2([ab])\$(\d{2})\$/.exec(hash);
    if (!match) return true;
    return Number(match[2]) < BCRYPT_COST;
}

export type PasswordPolicyFailure = 'empty' | 'too_short' | 'too_long';
export type PasswordPolicyResult = { ok: true } | { ok: false; reason: PasswordPolicyFailure };

/**
 * The policy for a NEW password: length only. NIST 800-63B deprecates
 * composition rules in favour of length and breach screening; breach
 * screening is `src/lib/security/password-check.ts`.
 */
export function validatePasswordPolicy(plaintext: string): PasswordPolicyResult {
    if (!plaintext) return { ok: false, reason: 'empty' };
    if (plaintext.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
    if (!fitsBcrypt(plaintext)) return { ok: false, reason: 'too_long' };
    return { ok: true };
}
