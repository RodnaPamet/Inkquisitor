/**
 * Per-workspace data keys (DEKs): generate, wrap, unwrap. Pure and in memory;
 * persistence and caching are `./workspace-key-manager.ts`.
 *
 *   DATA_ENCRYPTION_KEY ──HKDF──▶ master KEK
 *   master KEK ──AES-256-GCM──▶ Workspace.encryptedDek (`v1:` envelope)
 *   unwrapped DEK (32 bytes) ──AES-256-GCM──▶ field ciphertext (`v2:`)
 *
 * Lifted from inflect-compliance's `src/lib/security/tenant-keys.ts` (see
 * docs/carve-manifest.md), tenant renamed to workspace. Never log a DEK.
 */
import crypto from 'node:crypto';
import { decryptField, encryptField, isEncryptedValue } from './encryption';

/** A raw 32-byte workspace data key. Exists only in memory. */
export type WorkspaceDek = Buffer;
/** The stored form: the DEK, base64'd, in a `v1:` envelope under the master KEK. */
export type WrappedDek = string;

export const DEK_LENGTH_BYTES = 32;

export function generateDek(): WorkspaceDek {
    return crypto.randomBytes(DEK_LENGTH_BYTES);
}

export function wrapDek(dek: WorkspaceDek): WrappedDek {
    if (!Buffer.isBuffer(dek)) throw new Error('wrapDek: DEK must be a Buffer');
    if (dek.length !== DEK_LENGTH_BYTES) {
        throw new Error(`wrapDek: DEK must be exactly ${DEK_LENGTH_BYTES} bytes, got ${dek.length}`);
    }
    return encryptField(dek.toString('base64'));
}

export function unwrapDek(wrapped: WrappedDek): WorkspaceDek {
    if (!isEncryptedValue(wrapped)) {
        throw new Error('unwrapDek: value is not in the expected encrypted envelope');
    }
    const dek = Buffer.from(decryptField(wrapped), 'base64');
    if (dek.length !== DEK_LENGTH_BYTES) {
        throw new Error(`unwrapDek: decoded DEK has length ${dek.length}, expected ${DEK_LENGTH_BYTES}`);
    }
    return dek;
}

export function generateAndWrapDek(): { dek: WorkspaceDek; wrapped: WrappedDek } {
    const dek = generateDek();
    return { dek, wrapped: wrapDek(dek) };
}
