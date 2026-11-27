/**
 * Model calls for a workspace (Phase 2.1): `callStructured` bound to the
 * workspace's ledger. Every model feature (the question engine of 2.2, the
 * enrichment of 2.5, the research run of 2.6) calls a model through here, from
 * its own usecase, after its own permission check: calling the model is not a
 * permission of its own, it is part of whatever the feature does.
 *
 * Calling a model is NOT a permission of its own (issue #30, item 1, decided
 * 2026-11-19): a call is permitted under the calling feature's own permission
 * key, checked by its usecase before it calls here — `bible.edit` for an
 * interview's questions. There is no `ai.call` key; a feature that calls a
 * model without its own check is the defect, not a missing key.
 *
 * The ledger runs two SHORT transactions per call under the workspace's RLS —
 * the reservation before anything is sent, the settlement after — and holds
 * no transaction open across the model call itself (see
 * `src/app-layer/repositories/ai-call.repository.ts`).
 */
import type { z } from 'zod';

import type { WorkspaceRequestContext } from '@/app-layer/types';
import { AiCallRepository } from '@/app-layer/repositories/ai-call.repository';
import { periodStartOf, spendPeriod, type AiLedger } from '@/lib/ai/call-record';
import { aiDisabled, aiUnavailableReason, monthlyCeilingMicroUsd, type AiEnvRecord } from '@/lib/ai/config';
import type { AiUnavailableReason } from '@/lib/ai/errors';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { recordReservationsReleased } from '@/lib/ai/ledger-metrics';
import {
    callStructured as callStructuredCore,
    type StructuredCallDeps,
    type StructuredCallInput,
    type StructuredCallResult,
} from '@/lib/ai/call-structured';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import {
    runServerToolLoop as runServerToolLoopCore,
    type ServerToolLoopDeps,
    type ServerToolLoopInput,
    type ServerToolLoopResult,
} from '@/lib/ai/server-tool-loop';

/**
 * A purpose's NIGHTLY SHARE of the month (Phase 4.2, D28 addendum, item 1): the calls of `purpose` since `since` may
 * have charged and still hold at most `capMicroUsd` in the workspace. Checked by the ledger under its spend lock with
 * each reservation, so it holds across books and concurrent jobs. Since 5.3 (D35 item 2) a share may name SEVERAL
 * purposes, measured together and held for a call of any of them: the night's one share is the nightly draft
 * reading's and the deep continuity check's.
 */
export interface NightlyShare {
    readonly purpose: string | readonly string[];
    readonly since: Date;
    readonly capMicroUsd: number;
    /**
     * How a refusal at this share is named (default `NIGHTLY_SHARE`): 4.H-b's backfill holds a DAILY share (named as
     * the nightly one, a rolling window) and a share of the calendar month (`MONTHLY_SHARE`, D32), both by its purpose.
     */
    readonly limit?: 'NIGHTLY_SHARE' | 'MONTHLY_SHARE';
    /**
     * D35 addendum B (owner decision 2026-11-27): ONE purpose's HALF of this share. A call of `half.purpose` is held to
     * `half.capMicroUsd` (what that purpose has charged and holds since `since`, with the call's worst case) while the
     * OTHER purpose of the share still has work this night (`otherHasWork`, read in the ledger's own transaction, under
     * the spend lock, from committed rows); once it has none, the whole share is this purpose's. The share's total still
     * binds every call.
     */
    readonly half?: NightShareHalf;
}

/** One purpose's half of a share (D35 addendum B). */
export interface NightShareHalf {
    readonly purpose: string;
    readonly capMicroUsd: number;
    readonly otherHasWork: (db: PrismaTx) => Promise<boolean>;
}

/** The purposes a share measures (one, or several together). */
export function sharePurposes(share: Pick<NightlyShare, 'purpose'>): readonly string[] {
    return typeof share.purpose === 'string' ? [share.purpose] : share.purpose;
}

/** One share, several, or none, as a list. */
function sharesOf(share: NightlyShare | readonly NightlyShare[] | undefined): readonly NightlyShare[] {
    return share === undefined ? [] : Array.isArray(share) ? (share as readonly NightlyShare[]) : [share as NightlyShare];
}

/** What `share`'s purpose has charged and holds since its `since` (a read in the caller's transaction, no lock). */
export async function nightlyShareSpent(db: PrismaTx, ctx: Pick<WorkspaceRequestContext, 'workspaceId'>, share: NightlyShare): Promise<number> {
    const now = await AiCallRepository.dbNow(db);
    const s = await AiCallRepository.purposeSpendSince(db, ctx.workspaceId, share.purpose, share.since, now);
    return s.chargedMicroUsd + s.reservedMicroUsd;
}

/**
 * Whether a call of `share`'s half purpose costing `worstMicroUsd` would pass the night's share now (a read in the
 * caller's transaction, no lock: the job's own check before a call; the ledger repeats it under its spend lock as the
 * call reserves). `TOTAL`: past the share; `HALF`: past the purpose's half while the other purpose still has work.
 */
export async function nightShareStop(db: PrismaTx, ctx: Pick<WorkspaceRequestContext, 'workspaceId'>, share: NightlyShare, worstMicroUsd: number): Promise<'TOTAL' | 'HALF' | null> {
    if ((await nightlyShareSpent(db, ctx, share)) + worstMicroUsd > share.capMicroUsd) return 'TOTAL';
    if (share.half) {
        const mine = await nightlyShareSpent(db, ctx, { ...share, purpose: share.half.purpose });
        if (mine + worstMicroUsd > share.half.capMicroUsd && (await share.half.otherHasWork(db))) return 'HALF';
    }
    return null;
}

/**
 * The ledger of one workspace, over `AiCallLog`, `AiSpendMonth` and `AiSpendReservation` (and a purpose's shares,
 * when given: each is held under the spend lock with the reservation, so concurrent calls cannot pass one together).
 */
export function workspaceAiLedger(ctx: Pick<WorkspaceRequestContext, 'workspaceId' | 'requestId' | 'userId'>, share?: NightlyShare | readonly NightlyShare[]): AiLedger {
    const shares = sharesOf(share);
    return {
        async reserve(request) {
            const periodStart = periodStartOf(request.startedAt);
            return runInWorkspaceContext(ctx, async (db) => {
                await AiCallRepository.lockSpend(db, ctx.workspaceId);
                // The database's clock decides expiry (issue #30, item 9), and an
                // expired, unsettled reservation is released, charged nothing (D17),
                // logged and counted so the spend it may have lost is visible.
                const now = await AiCallRepository.dbNow(db);
                const released = await AiCallRepository.releaseExpired(db, ctx.workspaceId, now);
                if (released.length > 0) {
                    const reservedMicroUsd = released.reduce((sum, r) => sum + r.amountMicroUsd, 0);
                    logger.warn('ai.reservation_released', {
                        component: 'ai',
                        workspaceId: ctx.workspaceId,
                        reservationIds: released.map((r) => r.id),
                        count: released.length,
                        reservedMicroUsd,
                    });
                    recordReservationsReleased(released.length, reservedMicroUsd);
                }
                const period = spendPeriod(request.startedAt);
                for (const s of shares) {
                    if (request.purpose === undefined || !sharePurposes(s).includes(request.purpose)) continue;
                    const used = await AiCallRepository.purposeSpendSince(db, ctx.workspaceId, s.purpose, s.since, now, request.callId);
                    if (used.chargedMicroUsd + used.reservedMicroUsd + request.amountMicroUsd > s.capMicroUsd) {
                        return {
                            ok: false as const,
                            period,
                            spentMicroUsd: used.chargedMicroUsd,
                            reservedMicroUsd: used.reservedMicroUsd,
                            ceilingMicroUsd: s.capMicroUsd,
                            limit: s.limit ?? ('NIGHTLY_SHARE' as const),
                        };
                    }
                    // D35 addendum B: the purpose's half, while the other purpose still has work tonight. Read here, under
                    // the spend lock, so two calls cannot pass one half together; a purpose crosses its half only at a
                    // reservation that found the other with no work (and the total above keeps the two inside the share).
                    if (s.half && request.purpose === s.half.purpose) {
                        const mine = await AiCallRepository.purposeSpendSince(db, ctx.workspaceId, s.half.purpose, s.since, now, request.callId);
                        if (mine.chargedMicroUsd + mine.reservedMicroUsd + request.amountMicroUsd > s.half.capMicroUsd && (await s.half.otherHasWork(db))) {
                            return {
                                ok: false as const,
                                period,
                                spentMicroUsd: mine.chargedMicroUsd,
                                reservedMicroUsd: mine.reservedMicroUsd,
                                ceilingMicroUsd: s.half.capMicroUsd,
                                limit: s.limit ?? ('NIGHTLY_SHARE' as const),
                            };
                        }
                    }
                }
                const held = await AiCallRepository.reserve(db, ctx.workspaceId, {
                    purpose: request.purpose,
                    callId: request.callId,
                    periodStart,
                    amountMicroUsd: request.amountMicroUsd,
                    ceilingMicroUsd: request.ceilingMicroUsd,
                    expiresAt: new Date(now.getTime() + request.ttlMs),
                    now,
                });
                return held.ok
                    ? { ok: true as const, period }
                    : {
                          ok: false as const,
                          period,
                          spentMicroUsd: held.spentMicroUsd,
                          reservedMicroUsd: held.reservedMicroUsd,
                          ceilingMicroUsd: request.ceilingMicroUsd,
                      };
            });
        },
        async settle(record) {
            await runInWorkspaceContext(ctx, async (db) => {
                await AiCallRepository.lockSpend(db, ctx.workspaceId);
                await AiCallRepository.settle(db, ctx.workspaceId, record);
            });
        },
    };
}

/**
 * One structured model call in the context's workspace, recorded against it
 * and held to its monthly ceiling. `requestedById` is the context's user.
 */
export async function callStructured<S extends z.ZodType>(
    ctx: WorkspaceRequestContext,
    input: Omit<StructuredCallInput<S>, 'requestedById'>,
    deps: Omit<StructuredCallDeps, 'ledger'> = {},
    options: { share?: NightlyShare | readonly NightlyShare[] } = {},
): Promise<StructuredCallResult<z.infer<S>>> {
    return callStructuredCore({ ...input, requestedById: ctx.userId }, { ...deps, ledger: workspaceAiLedger(ctx, options.share) });
}

/**
 * Why no model call can be made at all right now, or null (the kill switch,
 * no key, ambient SDK headers, or — in production — no declared retention
 * mode). The same reading `clientForRun` refuses by, so a feature can refuse
 * BEFORE it writes anything rather than after a call it knew would fail.
 */
export function modelUnavailableReason(switches: AiEnvRecord = env): AiUnavailableReason | null {
    return aiUnavailableReason(switches);
}

/** What a feature reads before it starts work that will need a model call. */
export interface ModelBudgetState {
    /** `AI_DISABLED=1`. */
    readonly killSwitch: boolean;
    /**
     * The workspace's month cannot take a call whose worst case is
     * `nextCallWorstMicroUsd`: settled spend plus live reservations plus that
     * worst case passes the ceiling. A floor estimate: `callStructured`
     * reserves the real worst case and refuses CEILING when it does not fit.
     */
    readonly workspaceCeilingReached: boolean;
}

/**
 * The kill switch and the spend ceiling's state for the context's workspace,
 * read in the caller's `runInWorkspaceContext` transaction (no lock: a read
 * for a decision `callStructured` makes again, under the lock, at the call).
 */
export async function modelBudgetState(
    db: PrismaTx,
    ctx: Pick<WorkspaceRequestContext, 'workspaceId'>,
    nextCallWorstMicroUsd: number,
    switches: AiEnvRecord = env,
    now: Date = new Date(),
): Promise<ModelBudgetState> {
    if (aiDisabled(switches)) return { killSwitch: true, workspaceCeilingReached: false };
    const spend = await AiCallRepository.monthSpend(db, ctx.workspaceId, periodStartOf(now), now);
    const ceiling = monthlyCeilingMicroUsd(switches);
    return { killSwitch: false, workspaceCeilingReached: spend.spentMicroUsd + spend.reservedMicroUsd + nextCallWorstMicroUsd > ceiling };
}

/**
 * A server-tool turn in the context's workspace (Phase 2.6, the research run's
 * gather step): `runServerToolLoop` bound to the workspace's ledger, every
 * request recorded against it and held to its monthly ceiling. As with
 * `callStructured`, the calling feature checks its own permission first.
 */
export async function runServerToolLoop(
    ctx: WorkspaceRequestContext,
    input: Omit<ServerToolLoopInput, 'requestedById'>,
    deps: Omit<ServerToolLoopDeps, 'ledger'> = {},
): Promise<ServerToolLoopResult> {
    return runServerToolLoopCore({ ...input, requestedById: ctx.userId }, { ...deps, ledger: workspaceAiLedger(ctx) });
}
