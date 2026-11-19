/**
 * Field-level encryption primitives: AES-256-GCM with a versioned envelope.
 *
 * Lifted from inflect-compliance's `src/lib/security/encryption.ts` (see
 * docs/carve-manifest.md), cut to what Inkquisitor uses:
 *
 *   v1:  base64(iv ∥ ciphertext ∥ tag) under the MASTER KEK, HKDF-derived
 *        from DATA_ENCRYPTION_KEY. Used to wrap each workspace's data key
 *        (`./workspace-keys.ts`) and, as the fallback, for a manifest field
 *        written with no workspace in context.
 *   v2:  the same layout under a WORKSPACE data key (DEK). Every manifest
 *        field written inside `runInWorkspaceContext` is v2.
 *
 * iv 12 bytes (fresh per value), tag 16 bytes. The decrypt path dispatches
 * on the prefix, so mixed rows read correctly.
 *
 * Subphase 2.0 adds `deriveSubkey` (inflect's subkey derivation, cut to one
 * HKDF call): a purpose-labelled key derived from the same master material,
 * which the vector store's keyed content hash uses
 * (`src/lib/ai/embeddings/content-hash.ts`).
 *
 * Left behind: the lookup-hash key (no encrypted column is looked up by
 * value yet), the keyed change digest and the previous-KEK rotation
 * fallback. When master-key rotation arrives, a subkey's derivation must
 * survive it (inflect's DERIVED_SUBKEY_KEY), or every derived value moves. The master-key rotation arrives with the
 * first rotation runbook; until then a KEK change re-wraps every DEK
 * offline.
 *
 * Never log a plaintext, a key, or a ciphertext.
 */
import crypto from 'node:crypto';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY, MIN_DATA_ENCRYPTION_KEY_LENGTH } from './encryption-constants';

const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const VERSION_PREFIX_V1 = 'v1:';
const VERSION_PREFIX_V2 = 'v2:';

const ENCRYPT_INFO = 'inkquisitor-data-encryption';
const HKDF_SALT = 'inkquisitor-data-protection-salt-v1';

let cachedKey: Buffer | null = null;
let cachedKeySource: string | null = null;
let warnedFallback = false;

/**
 * The master key material. Required in production (refused at start-up by
 * `src/lib/startup-checks.ts` before this is ever reached); development and
 * test fall back to the documented key, development with a WARN.
 */
function rawKeyMaterial(): string {
    const key = env.DATA_ENCRYPTION_KEY;
    if (key && key.length >= MIN_DATA_ENCRYPTION_KEY_LENGTH) return key;
    if (env.NODE_ENV === 'production') {
        throw new Error(
            `DATA_ENCRYPTION_KEY is required in production and must be at least ${MIN_DATA_ENCRYPTION_KEY_LENGTH} ` +
                'characters. Generate one with: openssl rand -base64 48',
        );
    }
    if (env.NODE_ENV !== 'test' && !warnedFallback) {
        warnedFallback = true;
        logger.warn('Using the development fallback encryption key', { component: 'encryption' });
    }
    return DEV_FALLBACK_DATA_ENCRYPTION_KEY;
}

/** HKDF-SHA256 (extract + one expand block = 32 bytes). */
function deriveKey(material: string, info: string): Buffer {
    const prk = crypto.createHmac('sha256', Buffer.from(HKDF_SALT, 'utf8')).update(material, 'utf8').digest();
    return crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])])).digest();
}

function masterKey(): Buffer {
    const raw = rawKeyMaterial();
    if (cachedKey && cachedKeySource === raw) return cachedKey;
    cachedKey = deriveKey(raw, ENCRYPT_INFO);
    cachedKeySource = raw;
    return cachedKey;
}

function seal(key: Buffer, prefix: string, plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return prefix + Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64');
}

function open(key: Buffer, payload: string, where: string): string {
    const combined = Buffer.from(payload, 'base64');
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error(`${where}: ciphertext too short (truncated?)`);
    }
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
    const body = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function assertAesKey(key: Buffer, where: string): void {
    if (!Buffer.isBuffer(key)) throw new Error(`${where}: key must be a Buffer`);
    if (key.length !== KEY_LENGTH) {
        throw new Error(`${where}: key must be exactly ${KEY_LENGTH} bytes (got ${key.length})`);
    }
}

// ─── v1: the master KEK ─────────────────────────────────────────────

/** Encrypt under the master KEK (`v1:`). */
export function encryptField(plaintext: string): string {
    if (plaintext === null || plaintext === undefined) {
        throw new Error('encryptField: plaintext must not be null or undefined');
    }
    return seal(masterKey(), VERSION_PREFIX_V1, plaintext);
}

/** Decrypt a `v1:` envelope. Throws on tamper, truncation or a wrong key. */
export function decryptField(ciphertext: string): string {
    if (!ciphertext || !ciphertext.startsWith(VERSION_PREFIX_V1)) {
        throw new Error('decryptField: invalid ciphertext format. Expected version prefix "v1:"');
    }
    return open(masterKey(), ciphertext.slice(VERSION_PREFIX_V1.length), 'decryptField');
}

// ─── Purpose-labelled subkeys ───────────────────────────────────────

const subkeyCache = new Map<string, { source: string; key: Buffer }>();

/**
 * A 32-byte key for one named purpose, HKDF-derived from the master key
 * material under `info`. Never the encryption key itself: the KEK's own label
 * is refused, and a purpose's label is a literal at its one call site.
 */
export function deriveSubkey(info: string): Buffer {
    if (info === ENCRYPT_INFO || !/^inkquisitor-[a-z0-9-]+\/\d+$/.test(info)) {
        throw new Error('deriveSubkey: info must be a versioned purpose label (inkquisitor-<purpose>/<n>)');
    }
    const raw = rawKeyMaterial();
    const cached = subkeyCache.get(info);
    if (cached && cached.source === raw) return cached.key;
    const key = deriveKey(raw, info);
    subkeyCache.set(info, { source: raw, key });
    return key;
}

// ─── v2: a workspace data key ───────────────────────────────────────

/** Encrypt under a workspace DEK (`v2:`). Never pass the master KEK here. */
export function encryptWithKey(key: Buffer, plaintext: string): string {
    assertAesKey(key, 'encryptWithKey');
    if (plaintext === null || plaintext === undefined) {
        throw new Error('encryptWithKey: plaintext must not be null or undefined');
    }
    return seal(key, VERSION_PREFIX_V2, plaintext);
}

/** Decrypt a `v2:` envelope with a workspace DEK. Refuses a `v1:` envelope. */
export function decryptWithKey(key: Buffer, ciphertext: string): string {
    assertAesKey(key, 'decryptWithKey');
    if (!ciphertext || !ciphertext.startsWith(VERSION_PREFIX_V2)) {
        throw new Error('decryptWithKey: expected a v2: ciphertext; v1: is decrypted with decryptField.');
    }
    return open(key, ciphertext.slice(VERSION_PREFIX_V2.length), 'decryptWithKey');
}

/**
 * Decrypt a `v2:` envelope with the primary DEK, falling back to the
 * previous one while a rotation is in flight. Both failing re-throws the
 * PRIMARY error.
 */
export function decryptWithKeyOrPrevious(primary: Buffer, previous: Buffer | null, ciphertext: string): string {
    try {
        return decryptWithKey(primary, ciphertext);
    } catch (primaryErr) {
        if (!previous) throw primaryErr;
        try {
            return decryptWithKey(previous, ciphertext);
        } catch {
            throw primaryErr;
        }
    }
}

/**
 * True for a value SHAPED like a `v1:` or `v2:` envelope — a prefix check,
 * nothing more. It says how to try to open a stored value; it never proves a
 * value is ciphertext, so no write path may skip encryption on it (an
 * author's text can start `v2:` too).
 */
export function isEncryptedValue(value: unknown): value is string {
    return typeof value === 'string' && (value.startsWith(VERSION_PREFIX_V1) || value.startsWith(VERSION_PREFIX_V2));
}

/** The envelope version of a ciphertext, or null for anything else. */
export function getCiphertextVersion(value: unknown): 'v1' | 'v2' | null {
    if (typeof value !== 'string') return null;
    if (value.startsWith(VERSION_PREFIX_V1)) return 'v1';
    if (value.startsWith(VERSION_PREFIX_V2)) return 'v2';
    return null;
}

/** @internal Clears the derived-key cache (tests that change the key). */
export function _resetKeyCache(): void {
    cachedKey = null;
    cachedKeySource = null;
    subkeyCache.clear();
}
