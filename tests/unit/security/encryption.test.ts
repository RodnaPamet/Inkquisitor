/**
 * Field-encryption primitives, the per-workspace data keys and the start-up
 * sentinel. No database.
 */
import { randomBytes } from 'node:crypto';
import {
    _resetKeyCache,
    decryptField,
    decryptWithKey,
    decryptWithKeyOrPrevious,
    encryptField,
    encryptWithKey,
    getCiphertextVersion,
    isEncryptedValue,
} from '@/lib/security/encryption';
import { DEK_LENGTH_BYTES, generateAndWrapDek, unwrapDek, wrapDek } from '@/lib/security/workspace-keys';
import { EncryptionSentinelError, runEncryptionSentinel } from '@/lib/security/encryption-sentinel';

const TEXT = 'The lighthouse keeper never lit the lamp.';

afterEach(() => {
    delete process.env.DATA_ENCRYPTION_KEY;
    _resetKeyCache();
});

describe('v1: the master key', () => {
    it('round-trips, never leaks the plaintext, and uses a fresh IV each time', () => {
        const a = encryptField(TEXT);
        const b = encryptField(TEXT);
        expect(a).toMatch(/^v1:/);
        expect(a).not.toContain('lighthouse');
        expect(a).not.toBe(b);
        expect(decryptField(a)).toBe(TEXT);
    });

    it('refuses a tampered ciphertext', () => {
        const ct = encryptField(TEXT);
        const raw = Buffer.from(ct.slice(3), 'base64');
        raw[raw.length - 20] ^= 0xff;
        expect(() => decryptField(`v1:${raw.toString('base64')}`)).toThrow();
    });

    it('a different master key cannot read it', () => {
        const ct = encryptField(TEXT);
        process.env.DATA_ENCRYPTION_KEY = 'a-different-master-key-of-enough-length-1234';
        _resetKeyCache();
        expect(() => decryptField(ct)).toThrow();
    });
});

describe('v2: a workspace key', () => {
    it('round-trips with its key and refuses any other', () => {
        const key = randomBytes(32);
        const ct = encryptWithKey(key, TEXT);
        expect(getCiphertextVersion(ct)).toBe('v2');
        expect(decryptWithKey(key, ct)).toBe(TEXT);
        expect(() => decryptWithKey(randomBytes(32), ct)).toThrow();
    });

    it('falls back to the previous key during a rotation, and only then', () => {
        const old = randomBytes(32);
        const fresh = randomBytes(32);
        const ct = encryptWithKey(old, TEXT);
        expect(decryptWithKeyOrPrevious(fresh, old, ct)).toBe(TEXT);
        expect(() => decryptWithKeyOrPrevious(fresh, null, ct)).toThrow();
    });

    it('refuses a key of the wrong length', () => {
        expect(() => encryptWithKey(randomBytes(16), TEXT)).toThrow(/32 bytes/);
    });

    it('recognises envelopes and nothing else', () => {
        expect(isEncryptedValue(encryptField('x'))).toBe(true);
        expect(isEncryptedValue('plain text')).toBe(false);
        expect(isEncryptedValue(null)).toBe(false);
    });
});

describe('workspace data keys', () => {
    it('are 32 random bytes, stored wrapped under the master key', () => {
        const { dek, wrapped } = generateAndWrapDek();
        expect(dek).toHaveLength(DEK_LENGTH_BYTES);
        expect(wrapped).toMatch(/^v1:/);
        expect(unwrapDek(wrapped).equals(dek)).toBe(true);
        expect(wrapped).not.toContain(dek.toString('base64'));
    });

    it('refuses to wrap a key of the wrong size, or unwrap a non-envelope', () => {
        expect(() => wrapDek(randomBytes(31))).toThrow();
        expect(() => unwrapDek('not-an-envelope')).toThrow();
    });
});

describe('the start-up sentinel', () => {
    it('passes with a working key', () => {
        expect(() => runEncryptionSentinel()).not.toThrow();
    });

    it('fails, naming the stage, when the master key cannot round-trip', () => {
        const encryption = jest.requireActual<typeof import('@/lib/security/encryption')>('@/lib/security/encryption');
        const spy = jest.spyOn(encryption, 'decryptField').mockImplementation(() => 'something else');
        try {
            expect(() => runEncryptionSentinel()).toThrow(EncryptionSentinelError);
            expect(() => runEncryptionSentinel()).toThrow(/master-key round trip/);
        } finally {
            spy.mockRestore();
        }
    });
});
