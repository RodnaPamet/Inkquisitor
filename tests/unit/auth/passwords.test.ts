/**
 * The password primitives: the policy, the pre-hash that keeps bcrypt from
 * truncating, and verification.
 */
import { createHash } from 'node:crypto';
import {
    BCRYPT_COST,
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    hashPassword,
    needsRehash,
    prehashForBcrypt,
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

describe('prehashForBcrypt', () => {
    it('is base64(sha256(password)): 44 ASCII bytes whatever the input', () => {
        const pw = 'пароль-'.repeat(20);
        expect(prehashForBcrypt(pw)).toBe(createHash('sha256').update(pw, 'utf8').digest('base64'));
        expect(Buffer.byteLength(prehashForBcrypt(pw))).toBe(44);
        expect(Buffer.byteLength(prehashForBcrypt('a'))).toBe(44);
    });
});

describe('hash and verify', () => {
    it('round-trips, at the declared cost, and refuses a wrong password', async () => {
        const hash = await hashPassword('a-long-enough-passphrase');
        expect(hash).toMatch(new RegExp(`^\\$2b\\$${BCRYPT_COST}\\$`));
        expect(await verifyPassword('a-long-enough-passphrase', hash)).toBe(true);
        expect(await verifyPassword('a-long-enough-passphrasE', hash)).toBe(false);
    });

    it('does not truncate: two passwords sharing their first 72 bytes are different passwords', async () => {
        const prefix = 'й'.repeat(36); // 72 UTF-8 bytes
        const hash = await hashPassword(`${prefix}-one`);
        expect(await verifyPassword(`${prefix}-two`, hash)).toBe(false);
        expect(await verifyPassword(`${prefix}-one`, hash)).toBe(true);
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
