/**
 * The model layer's ledger (Phase 2.1): `AiCallLog`, `AiSpendMonth` and
 * `AiSpendReservation`. Workspace-scoped: every method runs on a transaction
 * from `runInWorkspaceContext` (the `workspace_isolation` policy) AND filters
 * by `workspaceId`. No authorization here.
 *
 * ── THE CEILING HOLDS UNDER CONCURRENCY ─────────────────────────────────────
 *
 * The month's spend is checked BEFORE a call against
 *
 *     settled spend this month  +  every live reservation  +  this call's worst case
 *
 * and the call's worst case is written as a reservation in the SAME
 * transaction, under a transaction-scoped advisory lock per workspace
 * (`hashtext('ai-spend:' || workspaceId)`). Settlement takes the same lock.
 * So two concurrent calls queue for the check: the second reads the first's
 * reservation (each statement under READ COMMITTED, which
 * `runInWorkspaceContext` uses, takes a fresh snapshot after the lock is
 * held) and is refused if both do not fit. A lock and a reservation row,
 * rather than either alone:
 *
 *   • a lock alone would have to be held for the whole model call (seconds to
 *     minutes) to cover the gap between check and charge, pinning a pooled
 *     connection and an open transaction to a network call;
 *   • a reservation row alone does not serialise two checks that read the
 *     same sum at once (nothing conflicts: they insert different rows).
 *
 * The lock is held for two short statements; the row carries the claim across
 * the call. A reservation EXPIRES (`expiresAt`, the call's deadline plus a
 * grace) so a process that dies mid-call stops holding budget; expired rows
 * are deleted lazily on the workspace's next reservation. The cost of such a
 * call, which nobody settled, is not counted: the trade-off for not leaking
 * budget forever.
 *
 * The settled spend lives in `AiSpendMonth`, not in a sum over `AiCallLog`:
 * a book's purge deletes its call records by cascade, and must not lower the
 * month the ceiling counts.
 */
import type { AiCallOutcome, AiModelTier, Prisma } from '@prisma/client';
import type { AiCallRecord } from '@/lib/ai/call-record';
import { periodStartOf } from '@/lib/ai/call-record';

type Db = Prisma.TransactionClient;

/** How long after expiry a reservation row is kept before the lazy sweep deletes it. */
const EXPIRED_ROW_RETENTION_MS = 24 * 60 * 60 * 1000;

const TIER: Readonly<Record<AiCallRecord['tier'], AiModelTier>> = { fast: 'FAST', balanced: 'BALANCED', deep: 'DEEP' };

export interface MonthSpend {
    readonly spentMicroUsd: number;
    readonly reservedMicroUsd: number;
}

export const AiCallRepository = {
    /** Serialise every check and settlement of one workspace's spend, until the transaction ends. */
    async lockSpend(db: Db, workspaceId: string): Promise<void> {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'ai-spend:' + workspaceId}))`;
    },

    /** Settled spend of the month and the live reservations held against it (excluding `exceptCallId`'s). */
    async monthSpend(db: Db, workspaceId: string, periodStart: Date, now: Date, exceptCallId?: string): Promise<MonthSpend> {
        const month = await db.aiSpendMonth.findUnique({
            where: { workspaceId_periodStart: { workspaceId, periodStart } },
            select: { spentMicroUsd: true },
        });
        const held = await db.aiSpendReservation.aggregate({
            where: {
                workspaceId,
                periodStart,
                expiresAt: { gt: now },
                ...(exceptCallId ? { id: { not: exceptCallId } } : {}),
            },
            _sum: { amountMicroUsd: true },
        });
        return { spentMicroUsd: Number(month?.spentMicroUsd ?? 0), reservedMicroUsd: Number(held._sum.amountMicroUsd ?? 0) };
    },

    /**
     * Under the lock: hold `amountMicroUsd` for `callId` if it fits, replacing
     * the call's earlier reservation (a repair re-reserves). The caller has
     * taken `lockSpend` in this transaction.
     */
    async reserve(
        db: Db,
        workspaceId: string,
        input: { callId: string; periodStart: Date; amountMicroUsd: number; ceilingMicroUsd: number; expiresAt: Date; now: Date },
    ): Promise<{ ok: boolean } & MonthSpend> {
        await db.aiSpendReservation.deleteMany({
            where: { workspaceId, expiresAt: { lt: new Date(input.now.getTime() - EXPIRED_ROW_RETENTION_MS) } },
        });
        const spend = await AiCallRepository.monthSpend(db, workspaceId, input.periodStart, input.now, input.callId);
        if (spend.spentMicroUsd + spend.reservedMicroUsd + input.amountMicroUsd > input.ceilingMicroUsd) {
            return { ok: false, ...spend };
        }
        await db.aiSpendReservation.upsert({
            where: { id: input.callId },
            create: {
                id: input.callId,
                workspaceId,
                periodStart: input.periodStart,
                amountMicroUsd: input.amountMicroUsd,
                expiresAt: input.expiresAt,
            },
            update: { amountMicroUsd: input.amountMicroUsd, expiresAt: input.expiresAt },
        });
        return { ok: true, ...spend };
    },

    /**
     * Under the lock: release the call's reservation, add its cost to its
     * month and append its record, in the caller's transaction.
     */
    async settle(db: Db, workspaceId: string, record: AiCallRecord): Promise<void> {
        const periodStart = periodStartOf(record.startedAt);
        await db.aiSpendReservation.deleteMany({ where: { workspaceId, id: record.id } });
        if (record.costMicroUsd > 0) {
            await db.aiSpendMonth.upsert({
                where: { workspaceId_periodStart: { workspaceId, periodStart } },
                create: { workspaceId, periodStart, spentMicroUsd: BigInt(record.costMicroUsd) },
                update: { spentMicroUsd: { increment: BigInt(record.costMicroUsd) } },
            });
        }
        await db.aiCallLog.create({
            data: {
                id: record.id,
                workspaceId,
                bookId: record.bookId,
                requestedById: record.requestedById,
                purpose: record.purpose,
                promptId: record.promptId,
                promptVersion: record.promptVersion,
                tier: TIER[record.tier],
                model: record.model,
                outputMode: record.outputMode,
                attempts: record.attempts,
                inputTokens: record.inputTokens,
                outputTokens: record.outputTokens,
                cacheReadTokens: record.cacheReadTokens,
                cacheWriteTokens: record.cacheWriteTokens,
                costMicroUsd: record.costMicroUsd,
                costEstimated: record.costEstimated,
                worstCaseMicroUsd: record.worstCaseMicroUsd,
                durationMs: record.durationMs,
                outcome: record.outcome as AiCallOutcome,
                errorCode: record.errorCode,
                guardRuleIds: [...record.guardRuleIds],
                guardReviewRequired: record.guardReviewRequired,
                webSearchRequests: record.webSearchRequests ?? 0,
                webFetchRequests: record.webFetchRequests ?? 0,
                startedAt: record.startedAt,
            },
        });
    },

    /**
     * Delete at most `batch` call records started before `cutoff`, oldest
     * first, across workspaces (Phase 2.H retention). Runs OUTSIDE row-level
     * security (`runWithoutRls`, reason `ai-call-log-retention`): the
     * append-only trigger admits it only there, and only for a row past its
     * floor. Returns how many went.
     */
    async deleteStartedBefore(db: Db, cutoff: Date, batch: number): Promise<number> {
        return db.$executeRaw`
            DELETE FROM "AiCallLog" WHERE "id" IN (
                SELECT "id" FROM "AiCallLog" WHERE "startedAt" < ${cutoff} ORDER BY "startedAt" ASC LIMIT ${batch}
            )`;
    },
};
