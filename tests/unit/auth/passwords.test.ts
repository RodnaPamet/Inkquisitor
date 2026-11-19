/**
 * The password primitives: the policy, the pre-hash that keeps bcrypt from
 * truncating, and verification.
 */
import {
    BCRYPT_COST,
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    hashPassword,
    needsRehash,
    MAX_PASSWORD_BYTES,
    validatePasswordPolicy,
    verifyPassword,
} from '@/lib/auth/passwords';

describe('validatePasswordPolicy', () => {
    it('refuses empty, short and over-long passwords, by reason', () => {
        expect(validatePasswordPolicy('')).toEqual({ ok: false, reason: 'empty' });
        expect(validatePasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toEqual({ ok: false, reason: 'too_short' });
        expect(validatePasswordPolicy('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toEqual({ ok: false, reason: 'too_long' });
    });

    it('accepts the bounds themselves, and needs no character classes (NIST 800-63B)', () => {
        expect(validatePasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH))).toEqual({ ok: true });
        expect(validatePasswordPolicy('x'.repeat(MAX_PASSWORD_LENGTH))).toEqual({ ok: true });
        expect(validatePasswordPolicy('alllowercaseletters')).toEqual({ ok: true });
    });
});

describe('hash and verify', () => {
    it('round-trips, at the declared cost, and refuses a wrong password', async () => {
        const hash = await hashPassword('a-long-enough-passphrase');
        expect(hash).toMatch(new RegExp(`^\\$2b\\$${BCRYPT_COST}\\$`));
        expect(await verifyPassword('a-long-enough-passphrase', hash)).toBe(true);
        expect(await verifyPassword('a-long-enough-passphrasE', hash)).toBe(false);
    });

    it('never truncates: a password bcrypt could not read in full is refused, by bytes not characters', async () => {
        const fits = 'й'.repeat(36); // exactly 72 UTF-8 bytes, 36 characters
        const over = 'й'.repeat(37); // 74 bytes, only 37 characters
        expect(MAX_PASSWORD_BYTES).toBe(72);
        expect(validatePasswordPolicy(fits)).toEqual({ ok: true });
        expect(validatePasswordPolicy(over)).toEqual({ ok: false, reason: 'too_long' });
        await expect(hashPassword(over)).rejects.toThrow(/72 bytes/);
        const hash = await hashPassword(fits);
        expect(await verifyPassword(fits, hash)).toBe(true);
        // Without the byte check bcrypt would read only the first 72 bytes and
        // accept this as the same password.
        expect(await verifyPassword(`${fits}-and-more`, hash)).toBe(false);
    });

    it('answers false, without throwing, for every malformed case', async () => {
        expect(await verifyPassword('', 'whatever')).toBe(false);
        expect(await verifyPassword('pw-pw-pw-pw', null)).toBe(false);
        expect(await verifyPassword('pw-pw-pw-pw', 'not-a-bcrypt-hash')).toBe(false);
        expect(await verifyPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1), '$2b$12$abcdefghijklmnopqrstuu')).toBe(false);
    });

    it('needsRehash flags a lower cost or a non-bcrypt hash', () => {
        expect(needsRehash(`$2b$${BCRYPT_COST}$abc`)).toBe(false);
        expect(needsRehash('$2b$10$abc')).toBe(true);
        expect(needsRehash('md5:abc')).toBe(true);
        expect(needsRehash(null)).toBe(false);
    });
});
