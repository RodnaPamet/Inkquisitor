/**
 * The encryption extension's traversal, against a TEST manifest (the shipped
 * one is empty until Phase 1): which fields of a write payload are sealed,
 * which of a result are opened, and what happens on a read that cannot be.
 */
import { randomBytes } from 'node:crypto';
import { _internals, withEncryptionExtension } from '@/lib/db/encryption-middleware';
import { compileManifest, ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { decryptWithKey, encryptWithKey, isEncryptedValue } from '@/lib/security/encryption';
import type { WorkspaceKeyManager } from '@/lib/security/workspace-key-manager';

const m = compileManifest({ BibleEntry: ['value', 'summary'] });
const dek = randomBytes(32);

describe('writes', () => {
    it('seals exactly the manifest fields of the model, under the workspace key', () => {
        const data: Record<string, unknown> = { value: 'She is afraid of the sea.', summary: 'Fear', title: 'Mara' };
        _internals.walkWrite(data, 'BibleEntry', dek, m);
        expect(isEncryptedValue(data.value)).toBe(true);
        expect(decryptWithKey(dek, data.value as string)).toBe('She is afraid of the sea.');
        expect(isEncryptedValue(data.summary)).toBe(true);
        expect(data.title).toBe('Mara');
    });

    it('reaches nested creates, and leaves empty values and envelopes alone', () => {
        const already = encryptWithKey(dek, 'already sealed');
        const data = { title: 'x', entries: { create: [{ value: 'nested secret', summary: '' }, { value: already }] } };
        _internals.walkWrite(data, 'Book', dek, m);
        const [first, second] = data.entries.create as Array<Record<string, unknown>>;
        expect(isEncryptedValue(first.value)).toBe(true);
        expect(first.summary).toBe('');
        expect(second.value).toBe(already);
    });

    it('without a workspace key, seals under the master key (v1), never leaves plaintext', () => {
        const data: Record<string, unknown> = { value: 'no workspace in context' };
        _internals.walkWrite(data, 'BibleEntry', null, m);
        expect(String(data.value)).toMatch(/^v1:/);
    });
});

describe('reads', () => {
    it('opens manifest fields with the workspace key', () => {
        const row = { value: encryptWithKey(dek, 'opened'), title: 'kept' };
        _internals.walkRead(row, 'BibleEntry', { primary: dek, previous: null, reason: 'resolved' }, m);
        expect(row).toEqual({ value: 'opened', title: 'kept' });
    });

    it('a v2 value with no workspace in context reads as null, never as ciphertext', () => {
        const row: Record<string, unknown> = { value: encryptWithKey(dek, 'hidden') };
        _internals.walkRead(row, 'BibleEntry', { primary: null, previous: null, reason: 'no-workspace' }, m);
        expect(row.value).toBeNull();
    });

    it('a value the key in hand cannot open throws, loudly', () => {
        const row = { value: encryptWithKey(randomBytes(32), 'other workspace') };
        expect(() => _internals.walkRead(row, 'BibleEntry', { primary: dek, previous: null, reason: 'resolved' }, m)).toThrow(/failed to decrypt/);
    });
});

describe('wiring', () => {
    it('the shipped manifest is empty, and an empty manifest adds no extension at all', () => {
        expect(ENCRYPTED_FIELDS).toEqual({});
        const client = { $extends: jest.fn() };
        const keys = {} as WorkspaceKeyManager;
        expect(withEncryptionExtension(client, { keys })).toBe(client);
        expect(client.$extends).not.toHaveBeenCalled();
        withEncryptionExtension(client, { keys, manifest: { BibleEntry: ['value'] } });
        expect(client.$extends).toHaveBeenCalledTimes(1);
    });
});
