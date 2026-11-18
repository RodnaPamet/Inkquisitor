/**
 * Transparent field-level encryption as a Prisma 7 query extension.
 *
 * Every field the manifest (`src/lib/security/encrypted-fields.ts`) lists is
 * encrypted on write and decrypted on read:
 *
 *   - inside `runInWorkspaceContext` the key is the WORKSPACE's data key and
 *     the envelope is `v2:`;
 *   - with no workspace in the database context the master KEK is used
 *     (`v1:`), so a value is never written in plaintext.
 *
 * Reads dispatch per value on the envelope, so `v1:` and `v2:` rows mix
 * safely. Writes skip a value that is already an envelope (idempotent under
 * nested writes and retries). `null`, `undefined` and `''` pass through.
 *
 * On a read that cannot be decrypted:
 *   - a `v2:` value with NO workspace in context → `null` (a caller outside
 *     every workspace has no business reading one, and a ciphertext handed
 *     on looks like a string to everything downstream);
 *   - the key lookup failed → the value unchanged, logged (a database blip
 *     must not null a page);
 *   - a key was in hand and AES-GCM refused the value → `DecryptIntegrityError`
 *     (wrong key, a corrupt row, or a row written under another workspace's
 *     context). Never silent.
 *
 * Lifted from inflect-compliance's `src/lib/db/encryption-middleware.ts`
 * (see docs/carve-manifest.md). Inkquisitor edits: the manifest and the key
 * manager are PARAMETERS (`src/lib/db.ts` passes the real ones; a test passes
 * its own), so there is no import cycle through the client; the bypass-source
 * list, the tenant-mismatch metric and the fail-open switch are not carried.
 */
import {
    decryptField,
    decryptWithKeyOrPrevious,
    encryptField,
    encryptWithKey,
    getCiphertextVersion,
    isEncryptedValue,
} from '@/lib/security/encryption';
import { compileManifest, ENCRYPTED_FIELDS, type CompiledManifest, type EncryptedFieldManifest } from '@/lib/security/encrypted-fields';
import type { WorkspaceKeyManager } from '@/lib/security/workspace-key-manager';
import { logger } from '@/lib/observability/logger';
import { getDbContext } from './db-context';

const WRITE_ACTIONS: ReadonlySet<string> = new Set([
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'updateManyAndReturn',
    'upsert',
]);

const RESULT_DECRYPT_ACTIONS: ReadonlySet<string> = new Set([
    'findFirst',
    'findUnique',
    'findFirstOrThrow',
    'findUniqueOrThrow',
    'findMany',
    'create',
    'createManyAndReturn',
    'update',
    'updateManyAndReturn',
    'upsert',
    'delete',
]);

/** A value that should have decrypted with the key in hand, and did not. Carries no value. */
export class DecryptIntegrityError extends Error {
    constructor(
        readonly model: string,
        readonly field: string,
        readonly version: string,
    ) {
        super(
            `encryption-middleware: failed to decrypt ${model}.${field} (${version}) with the workspace's key — ` +
                'wrong key, a corrupt row, or a write made under another workspace context',
        );
        this.name = 'DecryptIntegrityError';
    }
}

interface DekPair {
    primary: Buffer | null;
    previous: Buffer | null;
    reason: 'resolved' | 'no-workspace' | 'resolve-failed';
}

const NO_WORKSPACE: DekPair = { primary: null, previous: null, reason: 'no-workspace' };

class NoDekError extends Error {
    constructor(readonly dekReason: 'no-workspace' | 'resolve-failed') {
        super(`encryption-middleware: v2 ciphertext with no workspace key (${dekReason})`);
        this.name = 'NoDekError';
    }
}

async function resolveDeks(model: string, keys: WorkspaceKeyManager): Promise<DekPair> {
    // The key lives on Workspace: a Workspace query never resolves a key.
    if (model === 'Workspace') return NO_WORKSPACE;
    const workspaceId = getDbContext()?.workspaceId;
    if (!workspaceId) return NO_WORKSPACE;
    let primary: Buffer;
    try {
        primary = await keys.getDek(workspaceId);
    } catch (err) {
        logger.warn('encryption-middleware.dek_resolve_failed', {
            component: 'encryption-middleware',
            workspaceId,
            reason: err instanceof Error ? err.message : 'unknown',
        });
        return { primary: null, previous: null, reason: 'resolve-failed' };
    }
    let previous: Buffer | null = null;
    try {
        previous = await keys.getPreviousDek(workspaceId);
    } catch {
        // Steady state has none; a failed lookup only matters mid-rotation.
    }
    return { primary, previous, reason: 'resolved' };
}

function encryptValue(plaintext: string, dek: Buffer | null): string {
    return dek ? encryptWithKey(dek, plaintext) : encryptField(plaintext);
}

function encryptNode(node: Record<string, unknown>, fields: Iterable<string>, dek: Buffer | null): void {
    for (const field of fields) {
        const value = node[field];
        if (typeof value !== 'string' || value.length === 0 || isEncryptedValue(value)) continue;
        node[field] = encryptValue(value, dek);
    }
}

/** Walk a write payload; `model === '*'` (a nested write) checks every manifest field name. */
function walkWrite(payload: unknown, model: string, dek: Buffer | null, m: CompiledManifest): void {
    if (payload === null || payload === undefined) return;
    if (Array.isArray(payload)) {
        for (const item of payload) walkWrite(item, model, dek, m);
        return;
    }
    if (typeof payload !== 'object') return;
    const node = payload as Record<string, unknown>;
    if (model === '*') {
        if (m.nodeHasAnyEncryptedFieldKey(node)) encryptNode(node, Object.keys(node).filter((k) => m.allFieldNames.has(k)), dek);
    } else {
        encryptNode(node, m.fieldsOf(model) ?? [], dek);
    }
    for (const value of Object.values(node)) {
        if (!value || typeof value !== 'object') continue;
        const nested = value as Record<string, unknown>;
        if ('create' in nested) walkWrite(nested.create, '*', dek, m);
        if ('update' in nested) walkWrite(nested.update, '*', dek, m);
        if ('upsert' in nested) {
            const u = nested.upsert as Record<string, unknown> | undefined;
            walkWrite(u?.create, '*', dek, m);
            walkWrite(u?.update, '*', dek, m);
        }
        if ('connectOrCreate' in nested) {
            walkWrite((nested.connectOrCreate as Record<string, unknown> | undefined)?.create, '*', dek, m);
        }
        if ('createMany' in nested) {
            walkWrite((nested.createMany as Record<string, unknown> | undefined)?.data, '*', dek, m);
        }
    }
}

function decryptValue(ciphertext: string, deks: DekPair): string {
    const version = getCiphertextVersion(ciphertext);
    if (version === 'v1') return decryptField(ciphertext);
    if (!deks.primary) throw new NoDekError(deks.reason === 'resolve-failed' ? 'resolve-failed' : 'no-workspace');
    return decryptWithKeyOrPrevious(deks.primary, deks.previous, ciphertext);
}

function decryptField_(node: Record<string, unknown>, key: string, model: string, deks: DekPair): void {
    const value = node[key];
    if (!isEncryptedValue(value)) return;
    try {
        node[key] = decryptValue(value, deks);
    } catch (err) {
        const version = getCiphertextVersion(value) ?? 'unknown';
        const outcome =
            err instanceof NoDekError ? (err.dekReason === 'no-workspace' ? 'no_workspace' : 'dek_resolve_failed') : 'decrypt_failed';
        logger.warn('encryption-middleware.decrypt_failed', {
            component: 'encryption-middleware',
            model,
            field: key,
            version,
            outcome,
        });
        if (outcome === 'no_workspace') node[key] = null;
        else if (outcome === 'decrypt_failed') throw new DecryptIntegrityError(model, key, version);
        // dek_resolve_failed: left as it was.
    }
}

function walkRead(result: unknown, model: string, deks: DekPair, m: CompiledManifest): void {
    if (result === null || result === undefined) return;
    if (Array.isArray(result)) {
        for (const item of result) walkRead(item, model, deks, m);
        return;
    }
    if (typeof result !== 'object' || result instanceof Date) return;
    const node = result as Record<string, unknown>;
    const own = model === '*' ? undefined : m.fieldsOf(model);
    if (model === '*') {
        for (const key of Object.keys(node)) if (m.allFieldNames.has(key)) decryptField_(node, key, '*', deks);
    } else if (own) {
        for (const key of own) decryptField_(node, key, model, deks);
    }
    for (const [key, value] of Object.entries(node)) {
        if (!value || typeof value !== 'object') continue;
        if (own?.includes(key)) continue;
        walkRead(value, '*', deks, m);
    }
}

export interface EncryptionExtensionOptions {
    keys: WorkspaceKeyManager;
    manifest?: EncryptedFieldManifest;
}

/** Wire the field-encryption extension onto a client. */
export function withEncryptionExtension<T extends object>(client: T, options: EncryptionExtensionOptions): T {
    const m = compileManifest(options.manifest ?? ENCRYPTED_FIELDS);
    // An empty manifest has nothing to do; skip the extension rather than
    // pay a DEK lookup per query for no field.
    if (m.isEmpty) return client;
    const { keys } = options;
    return (client as { $extends: (cfg: unknown) => unknown }).$extends({
        name: 'field-encryption',
        query: {
            $allModels: {
                async $allOperations({
                    model,
                    operation,
                    args,
                    query,
                }: {
                    model: string;
                    operation: string;
                    args: { data?: unknown; create?: unknown; update?: unknown };
                    query: (a: unknown) => Promise<unknown>;
                }) {
                    const isWrite = WRITE_ACTIONS.has(operation);
                    const isRead = RESULT_DECRYPT_ACTIONS.has(operation);
                    const deks = isWrite || isRead ? await resolveDeks(model, keys) : NO_WORKSPACE;
                    const target = m.isEncryptedModel(model) ? model : '*';
                    if (isWrite) {
                        walkWrite(args?.data, target, deks.primary, m);
                        if (operation === 'upsert') {
                            walkWrite(args?.create, target, deks.primary, m);
                            walkWrite(args?.update, target, deks.primary, m);
                        }
                    }
                    const result = await query(args);
                    if (isRead) walkRead(result, target, deks, m);
                    return result;
                },
            },
        },
    }) as T;
}

/** @internal exposed for the traversal unit tests. */
export const _internals = { walkWrite, walkRead };
