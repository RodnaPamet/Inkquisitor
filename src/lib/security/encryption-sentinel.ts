/**
 * The encryption start-up sentinel: one encrypt → decrypt round trip under
 * the master KEK and one through a freshly wrapped workspace key, run by the
 * web tier (`src/instrumentation-node.ts`) and the worker (`scripts/worker.ts`)
 * before either serves anything.
 *
 * The start-up checks prove a key is PRESENT and long enough; this proves it
 * WORKS — a key that passes the structural checks but breaks HKDF or AES (a
 * truncated paste, a wrong encoding) fails here, at boot, instead of on the
 * first write of author text. It touches no database.
 *
 * Lifted from inflect-compliance's `runEncryptionSentinel` in
 * `src/lib/security/startup-encryption-check.ts` (see docs/carve-manifest.md).
 */
import { randomBytes } from 'node:crypto';
import { decryptField, decryptWithKey, encryptField, encryptWithKey } from './encryption';
import { generateAndWrapDek, unwrapDek } from './workspace-keys';

export class EncryptionSentinelError extends Error {
    constructor(stage: string) {
        super(`encryption sentinel failed at ${stage}: the master key cannot round-trip a value`);
        this.name = 'EncryptionSentinelError';
    }
}

/** Throws `EncryptionSentinelError` naming the stage that failed. Never logs a key or value. */
export function runEncryptionSentinel(): void {
    const probe = `sentinel:${randomBytes(12).toString('hex')}`;
    let stage = 'master-key round trip';
    try {
        if (decryptField(encryptField(probe)) !== probe) throw new Error('mismatch');
        stage = 'workspace key wrap';
        const { dek, wrapped } = generateAndWrapDek();
        if (!unwrapDek(wrapped).equals(dek)) throw new Error('mismatch');
        stage = 'workspace key round trip';
        if (decryptWithKey(dek, encryptWithKey(dek, probe)) !== probe) throw new Error('mismatch');
    } catch {
        throw new EncryptionSentinelError(stage);
    }
}
