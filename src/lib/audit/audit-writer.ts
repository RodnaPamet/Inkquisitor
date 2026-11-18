/**
 * The append-only, hash-chained audit trail: the ONLY writer of `AuditLog`.
 *
 * Each workspace has its own chain. An append, inside one transaction under
 * that workspace's row-level security:
 *   1. takes `pg_advisory_xact_lock(hashtext('audit:' || workspaceId))`, so
 *      concurrent appends to one workspace serialise and the chain never
 *      forks;
 *   2. reads the workspace's last row (its hash and timestamp);
 *   3. computes this row's hash over its canonical fields and that hash;
 *   4. inserts.
 * A database trigger refuses UPDATE, DELETE and TRUNCATE on the table for
 * every role, so a row once written stays as written; `verifyAuditChain`
 * recomputes every hash and reports the first break.
 *
 * Lifted from inflect-compliance's `src/lib/audit/audit-writer.ts` (see
 * docs/carve-manifest.md), simplified as the Phase 0.3 brief asks: no
 * outbox, no SIEM streaming, no legacy free-text `details`, no erasure
 * tolerances; the append runs under row-level security as app_user rather
 * than on the owning connection.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { runInWorkspaceContext, runWithoutRls, type PrismaTx } from '@/lib/db/rls-middleware';
import { computeEntryHash, nextChainTimestamp, toCanonicalTimestamp, toStoredAuditJson } from './canonical-hash';

export type AuditActorType = 'USER' | 'SYSTEM';

export interface AppendAuditInput {
    workspaceId: string;
    actorUserId: string | null;
    actorType?: AuditActorType;
    /** SCREAMING_SNAKE event name, e.g. `USER_SIGNED_UP`. */
    action: string;
    entityType: string;
    entityId: string | null;
    /** Ids, counts and codes. Never author text, never a credential. */
    detailsJson?: Record<string, unknown>;
    requestId?: string | null;
}

export interface AppendAuditResult {
    id: string;
    entryHash: string;
    previousHash: string | null;
}

const CURRENT_VERSION = 1;

/**
 * Append inside a transaction the caller already holds, which must be under
 * the workspace's row-level security (`runInWorkspaceContext`, or the
 * sign-up transaction after it switched role). Use this to make the audit
 * row part of the change it records.
 */
export async function appendAuditEntryWithin(tx: PrismaTx, input: AppendAuditInput): Promise<AppendAuditResult> {
    const id = randomUUID();
    const actorType = input.actorType ?? 'USER';
    const details = toStoredAuditJson(input.detailsJson ?? {});

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'audit:' + input.workspaceId}))`;

    const last = await tx.$queryRaw<Array<{ entryHash: string; createdAtMs: number }>>`
        SELECT "entryHash", (EXTRACT(EPOCH FROM "createdAt") * 1000)::float8 AS "createdAtMs"
        FROM "AuditLog"
        WHERE "workspaceId" = ${input.workspaceId}
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 1`;
    const previousHash = last[0]?.entryHash ?? null;
    const occurredAt = toCanonicalTimestamp(nextChainTimestamp(last[0]?.createdAtMs));

    const entryHash = computeEntryHash({
        workspaceId: input.workspaceId,
        actorType,
        actorUserId: input.actorUserId,
        eventType: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        occurredAt,
        detailsJson: details,
        previousHash,
        version: CURRENT_VERSION,
    });

    await tx.$executeRaw`
        INSERT INTO "AuditLog" (
            "id", "workspaceId", "actorUserId", "actorType", "action", "entityType", "entityId",
            "detailsJson", "requestId", "previousHash", "entryHash", "version", "createdAt"
        ) VALUES (
            ${id}, ${input.workspaceId}, ${input.actorUserId}, ${actorType}, ${input.action},
            ${input.entityType}, ${input.entityId}, ${JSON.stringify(details)}::jsonb, ${input.requestId ?? null},
            ${previousHash}, ${entryHash}, ${CURRENT_VERSION}, ${occurredAt}::timestamp
        )`;

    return { id, entryHash, previousHash };
}

/** Append in a transaction of its own, under the workspace's row-level security. */
export async function appendAuditEntry(
    input: AppendAuditInput,
    options: { client?: PrismaClient } = {},
): Promise<AppendAuditResult> {
    return runInWorkspaceContext(
        { workspaceId: input.workspaceId, userId: input.actorUserId ?? undefined, requestId: input.requestId ?? randomUUID() },
        (tx) => appendAuditEntryWithin(tx, input),
        { client: options.client },
    );
}

export interface ChainVerificationResult {
    workspaceId: string;
    totalEntries: number;
    valid: boolean;
    /** 0-based position of the first row whose link or hash does not verify. */
    firstBreakAt?: number;
    firstBreakId?: string;
}

/** Recompute every hash in a workspace's chain, oldest first. */
export async function verifyAuditChain(
    workspaceId: string,
    options: { client?: PrismaClient } = {},
): Promise<ChainVerificationResult> {
    const rows = await runWithoutRls({ reason: 'audit-verification', client: options.client }, (db) =>
        db.$queryRaw<
            Array<{
                id: string;
                actorUserId: string | null;
                actorType: string;
                action: string;
                entityType: string;
                entityId: string | null;
                detailsJson: unknown;
                previousHash: string | null;
                entryHash: string;
                version: number;
                createdAtIso: string;
            }>
        >`
            SELECT "id", "actorUserId", "actorType", "action", "entityType", "entityId", "detailsJson",
                   "previousHash", "entryHash", "version",
                   to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAtIso"
            FROM "AuditLog"
            WHERE "workspaceId" = ${workspaceId}
            ORDER BY "createdAt" ASC, "id" ASC`,
    );

    let expectedPrevious: string | null = null;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const recomputed = computeEntryHash({
            workspaceId,
            actorType: row.actorType,
            actorUserId: row.actorUserId,
            eventType: row.action,
            entityType: row.entityType,
            entityId: row.entityId,
            occurredAt: row.createdAtIso,
            detailsJson: row.detailsJson,
            previousHash: row.previousHash,
            version: row.version,
        });
        if (row.previousHash !== expectedPrevious || recomputed !== row.entryHash) {
            return { workspaceId, totalEntries: rows.length, valid: false, firstBreakAt: i, firstBreakId: row.id };
        }
        expectedPrevious = row.entryHash;
    }
    return { workspaceId, totalEntries: rows.length, valid: true };
}
