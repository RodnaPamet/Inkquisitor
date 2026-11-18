/**
 * The audit trail's canonical hash: SHA-256 over a key-sorted JSON form of a
 * row's fields and the previous row's hash.
 *
 * Changing the field list, the canonical form or the timestamp form breaks
 * verification of every row written before the change. Do not, without a
 * `version` bump that the verifier dispatches on.
 *
 * Lifted from inflect-compliance's `src/lib/audit/canonical-hash.ts` (see
 * docs/carve-manifest.md): `tenantId` → `workspaceId`, code unchanged.
 */
import { createHash } from 'node:crypto';

export interface HashInput {
    workspaceId: string;
    actorType: string;
    actorUserId: string | null;
    eventType: string;
    entityType: string;
    entityId: string | null;
    /** ISO-8601 UTC, millisecond precision. */
    occurredAt: string;
    detailsJson: unknown;
    previousHash: string | null;
    version: number;
}

/** Deterministic JSON: object keys sorted at every level, `undefined` members dropped. */
export function canonicalJsonStringify(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map((item) => canonicalJsonStringify(item)).join(',') + ']';
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const pairs = Object.keys(record)
            .sort()
            .filter((key) => record[key] !== undefined)
            .map((key) => JSON.stringify(key) + ':' + canonicalJsonStringify(record[key]));
        return '{' + pairs.join(',') + '}';
    }
    return JSON.stringify(value);
}

export function computeEntryHash(input: HashInput): string {
    const payload = {
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        detailsJson: input.detailsJson,
        entityId: input.entityId,
        entityType: input.entityType,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        previousHash: input.previousHash,
        version: input.version,
        workspaceId: input.workspaceId,
    };
    return createHash('sha256').update(canonicalJsonStringify(payload), 'utf8').digest('hex');
}

/** `YYYY-MM-DDTHH:mm:ss.SSSZ`. */
export function toCanonicalTimestamp(date: Date): string {
    return date.toISOString();
}

/**
 * The timestamp for the next row in a chain: now, or 1 ms after the last
 * row when the clock has not moved past it, so the chain's order is total.
 */
export function nextChainTimestamp(lastMs: number | string | null | undefined, now: Date = new Date()): Date {
    if (lastMs === null || lastMs === undefined) return now;
    const last = Math.round(Number(lastMs));
    if (!Number.isFinite(last)) return now;
    return now.getTime() > last ? now : new Date(last + 1);
}

/** What the row stores and what the hash reads: JSON round-tripped, so they agree byte for byte. */
export function toStoredAuditJson(value: unknown): unknown {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
