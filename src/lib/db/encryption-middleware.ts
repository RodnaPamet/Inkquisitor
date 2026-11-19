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
 * WHICH fields: only the manifest entry of the model the value belongs to.
 * The operation's model decides the top level; a nested write or an included
 * relation is resolved to ITS model through the schema's relations (Prisma's
 * DMMF), and that model's entry applies. A model the manifest does not list
 * encrypts nothing, even a field whose NAME is listed for another model.
 *
 * Writes seal EVERY non-empty string of a listed field, with no "already an
 * envelope" skip: a plaintext may start `v2:` as easily as anything else.
 * The payload is copied, never mutated, so a retried write seals the
 * plaintext again rather than a ciphertext. Reads open per value on the
 * envelope, so `v1:` and `v2:` rows mix safely. `null`, `undefined` and `''`
 * pass through.
 *
 * On a read that cannot be decrypted:
 *   - a `v2:` value with NO workspace in context → `null` (a caller outside
 *     every workspace has no business reading one);
 *   - the workspace's key could not be resolved → `EncryptionKeyUnavailableError`
 *     (handing the ciphertext on would let a caller save it back as text);
 *   - a key was in hand and AES-GCM refused the value → `DecryptIntegrityError`
 *     (wrong key, a corrupt row, or a row written under another workspace's
 *     context). Never silent.
 *
 * Lifted from inflect-compliance's `src/lib/db/encryption-middleware.ts`
 * (see docs/carve-manifest.md). Inkquisitor edits: the manifest and the key
 * manager are PARAMETERS (`src/lib/db.ts` passes the real ones; a test passes
 * its own), so there is no import cycle through the client; nested writes and
 * reads are resolved through the DMMF instead of matching any manifest field
 * name; the envelope-prefix skip is gone; the key is resolved before the
 * transaction; the bypass-source list, the tenant-mismatch metric and the
 * fail-open switch are not carried.
 */
import { Prisma } from '@prisma/client';
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

/**
 * A `v2:` value was read inside a workspace whose key could not be resolved.
 * Thrown rather than handing the ciphertext on: a caller that saved it back
 * would store a ciphertext as the author's text, sealed again.
 */
export class EncryptionKeyUnavailableError extends Error {
    constructor(
        readonly model: string,
        readonly field: string,
    ) {
        super(`encryption-middleware: no workspace key to decrypt ${model}.${field}`);
        this.name = 'EncryptionKeyUnavailableError';
    }
}

// ─── The model graph: which model a relation field leads to ─────────

/** The slice of Prisma's DMMF the traversal needs. */
export interface ModelShape {
    name: string;
    fields: ReadonlyArray<{ name: string; kind: string; type: string }>;
}

export interface ModelGraph {
    hasModel(model: string): boolean;
    /** The model a relation field of `model` points at, or undefined for a scalar / unknown field. */
    relatedModel(model: string, field: string): string | undefined;
    relationsOf(model: string): ReadonlyArray<readonly [field: string, related: string]>;
    hasField(model: string, field: string): boolean;
}

/** From the given model shapes, or from the generated client's DMMF. */
export function buildModelGraph(models: ReadonlyArray<ModelShape> = Prisma.dmmf.datamodel.models): ModelGraph {
    const relations = new Map<string, Map<string, string>>();
    const fields = new Map<string, Set<string>>();
    for (const model of models) {
        const rel = new Map<string, string>();
        const all = new Set<string>();
        for (const f of model.fields) {
            all.add(f.name);
            if (f.kind === 'object') rel.set(f.name, f.type);
        }
        relations.set(model.name, rel);
        fields.set(model.name, all);
    }
    return {
        hasModel: (model) => relations.has(model),
        relatedModel: (model, field) => relations.get(model)?.get(field),
        relationsOf: (model) => [...(relations.get(model) ?? new Map<string, string>()).entries()],
        hasField: (model, field) => fields.get(model)?.has(field) ?? false,
    };
}

/** Models from which a manifest model is reachable through relations (itself included). */
function modelsReachingEncryption(graph: ModelGraph, m: CompiledManifest, models: Iterable<string>): Set<string> {
    const reach = new Set<string>();
    const all = [...models];
    let changed = true;
    for (const model of all) if (m.isEncryptedModel(model)) reach.add(model);
    while (changed) {
        changed = false;
        for (const model of all) {
            if (reach.has(model)) continue;
            if (graph.relationsOf(model).some(([, related]) => reach.has(related))) {
                reach.add(model);
                changed = true;
            }
        }
    }
    return reach;
}

// ─── Keys ───────────────────────────────────────────────────────────

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

/**
 * The keys for this operation. `runInWorkspaceContext` resolves them BEFORE
 * it opens its transaction and puts them in the database context, so the
 * common path makes no query here: a lookup from inside the transaction
 * would need a second pooled connection while the transaction holds the
 * first. The fallback lookup serves a context bound without them.
 */
async function resolveDeks(keys: WorkspaceKeyManager): Promise<DekPair> {
    const ctx = getDbContext();
    const workspaceId = ctx?.workspaceId;
    if (!workspaceId) return NO_WORKSPACE;
    if (ctx.deks) return { primary: ctx.deks.primary, previous: ctx.deks.previous, reason: 'resolved' };
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

// ─── Writes ─────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function eachItem(value: unknown, fn: (item: unknown) => unknown): unknown {
    return Array.isArray(value) ? value.map(fn) : fn(value);
}

interface SealContext {
    dek: Buffer | null;
    m: CompiledManifest;
    graph: ModelGraph;
}

function sealValue(plaintext: string, dek: Buffer | null): string {
    // EVERY non-empty string is sealed. There is no "already an envelope"
    // skip: an author's text may begin `v2:` like anything else, and a prefix
    // proves nothing. Idempotency comes from never mutating the caller's
    // payload (each walk copies), so a retry seals the plaintext again.
    return dek ? encryptWithKey(dek, plaintext) : encryptField(plaintext);
}

/** `{ where?, data }` — the wrapper form of a nested update, unless the model itself has a `data` field. */
function isUpdateWrapper(item: unknown, model: string, graph: ModelGraph): item is { data: unknown } {
    if (!isPlainObject(item) || !('data' in item) || graph.hasField(model, 'data')) return false;
    return Object.keys(item).every((k) => k === 'data' || k === 'where');
}

/** A copy of a write payload for `model` with its manifest fields sealed, nested writes resolved by relation. */
function sealData(payload: unknown, model: string, dek: Buffer | null, m: CompiledManifest, graph: ModelGraph): unknown {
    return sealNode(payload, model, { dek, m, graph });
}

function sealNode(payload: unknown, model: string, c: SealContext): unknown {
    if (Array.isArray(payload)) return payload.map((item) => sealNode(item, model, c));
    if (!isPlainObject(payload)) return payload;
    const out: Record<string, unknown> = { ...payload };
    for (const field of c.m.fieldsOf(model) ?? []) {
        const value = out[field];
        if (typeof value === 'string' && value.length > 0) out[field] = sealValue(value, c.dek);
        else if (isPlainObject(value) && typeof value.set === 'string' && value.set.length > 0) {
            out[field] = { ...value, set: sealValue(value.set, c.dek) };
        }
    }
    for (const [field, related] of c.graph.relationsOf(model)) {
        if (field in out) out[field] = sealRelationOps(out[field], related, c);
    }
    return out;
}

function sealRelationOps(ops: unknown, related: string, c: SealContext): unknown {
    if (!isPlainObject(ops)) return ops;
    const out: Record<string, unknown> = { ...ops };
    const data = (value: unknown) => sealNode(value, related, c);
    const update = (item: unknown) => (isUpdateWrapper(item, related, c.graph) ? { ...item, data: data(item.data) } : data(item));
    if ('create' in out) out.create = data(out.create);
    if (isPlainObject(out.createMany)) out.createMany = { ...out.createMany, data: data(out.createMany.data) };
    if ('connectOrCreate' in out) {
        out.connectOrCreate = eachItem(out.connectOrCreate, (item) => (isPlainObject(item) ? { ...item, create: data(item.create) } : item));
    }
    if ('update' in out) out.update = eachItem(out.update, update);
    if ('updateMany' in out) out.updateMany = eachItem(out.updateMany, (item) => (isPlainObject(item) ? { ...item, data: data(item.data) } : item));
    if ('upsert' in out) {
        out.upsert = eachItem(out.upsert, (item) =>
            isPlainObject(item) ? { ...item, ...('create' in item ? { create: data(item.create) } : {}), ...('update' in item ? { update: update(item.update) } : {}) } : item,
        );
    }
    return out;
}

/** The operation's args with every write payload sealed. Never mutates `args`. */
function sealArgs(operation: string, args: unknown, model: string, c: SealContext): unknown {
    if (!isPlainObject(args)) return args;
    switch (operation) {
        case 'create':
        case 'createMany':
        case 'createManyAndReturn':
        case 'update':
        case 'updateMany':
        case 'updateManyAndReturn':
            return 'data' in args ? { ...args, data: sealNode(args.data, model, c) } : args;
        case 'upsert':
            return { ...args, create: sealNode(args.create, model, c), update: sealNode(args.update, model, c) };
        default:
            return args;
    }
}

// ─── Reads ──────────────────────────────────────────────────────────

function decryptValue(ciphertext: string, deks: DekPair): string {
    const version = getCiphertextVersion(ciphertext);
    if (version === 'v1') return decryptField(ciphertext);
    if (!deks.primary) throw new NoDekError(deks.reason === 'resolve-failed' ? 'resolve-failed' : 'no-workspace');
    return decryptWithKeyOrPrevious(deks.primary, deks.previous, ciphertext);
}

function openField(node: Record<string, unknown>, key: string, model: string, deks: DekPair): void {
    const value = node[key];
    // Every manifest value is written sealed, so a stored value is an envelope.
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
        else if (outcome === 'dek_resolve_failed') throw new EncryptionKeyUnavailableError(model, key);
        else throw new DecryptIntegrityError(model, key, version);
    }
}

/** Open a result's manifest fields in place: `model`'s own, then each included relation's by ITS model. */
function walkRead(result: unknown, model: string, deks: DekPair, m: CompiledManifest, graph: ModelGraph): void {
    if (result === null || result === undefined) return;
    if (Array.isArray(result)) {
        for (const item of result) walkRead(item, model, deks, m, graph);
        return;
    }
    if (typeof result !== 'object' || result instanceof Date) return;
    const node = result as Record<string, unknown>;
    for (const key of m.fieldsOf(model) ?? []) openField(node, key, model, deks);
    for (const [field, related] of graph.relationsOf(model)) {
        const value = node[field];
        if (value && typeof value === 'object') walkRead(value, related, deks, m, graph);
    }
}

// ─── Wiring ─────────────────────────────────────────────────────────

export interface EncryptionExtensionOptions {
    keys: WorkspaceKeyManager;
    manifest?: EncryptedFieldManifest;
    /** Replaces the schema's model graph (unit tests run against their own models). */
    graph?: ModelGraph;
}

/** True when `withEncryptionExtension` would install anything for this manifest. */
export function encryptionIsActive(manifest: EncryptedFieldManifest = ENCRYPTED_FIELDS): boolean {
    return !compileManifest(manifest).isEmpty;
}

/** Wire the field-encryption extension onto a client. */
export function withEncryptionExtension<T extends object>(client: T, options: EncryptionExtensionOptions): T {
    const m = compileManifest(options.manifest ?? ENCRYPTED_FIELDS);
    // An empty manifest has nothing to do; skip the extension rather than
    // pay a DEK lookup per query for no field.
    if (m.isEmpty) return client;
    const { keys } = options;
    const graph = options.graph ?? buildModelGraph();
    const models = new Set<string>(Object.keys(options.manifest ?? ENCRYPTED_FIELDS));
    for (const shape of Prisma.dmmf.datamodel.models) models.add(shape.name);
    const reaching = modelsReachingEncryption(graph, m, [...models].filter((name) => graph.hasModel(name) || m.isEncryptedModel(name)));
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
                    args: unknown;
                    query: (a: unknown) => Promise<unknown>;
                }) {
                    // A model that neither holds a manifest field nor reaches
                    // one through a relation has nothing to seal or open. An
                    // unknown model encrypts nothing.
                    if (!reaching.has(model)) return query(args);
                    const isRead = RESULT_DECRYPT_ACTIONS.has(operation);
                    const writes = WRITE_ACTIONS.has(operation);
                    if (!writes && !isRead) return query(args);
                    const deks = await resolveDeks(keys);
                    const finalArgs = writes ? sealArgs(operation, args, model, { dek: deks.primary, m, graph }) : args;
                    const result = await query(finalArgs);
                    if (isRead) walkRead(result, model, deks, m, graph);
                    return result;
                },
            },
        },
    }) as T;
}

/** @internal exposed for the traversal unit tests. */
export const _internals = { sealData, walkRead };
