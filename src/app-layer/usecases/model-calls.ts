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

/** The ledger of one workspace, over `AiCallLog`, `AiSpendMonth` and `AiSpendReservation`. */
export function workspaceAiLedger(ctx: Pick<WorkspaceRequestContext, 'workspaceId' | 'requestId' | 'userId'>): AiLedger {
    return {
        async reserve(request) {
            const now = new Date();
            const periodStart = periodStartOf(request.startedAt);
            return runInWorkspaceContext(ctx, async (db) => {
                await AiCallRepository.lockSpend(db, ctx.workspaceId);
                const held = await AiCallRepository.reserve(db, ctx.workspaceId, {
                    callId: request.callId,
                    periodStart,
                    amountMicroUsd: request.amountMicroUsd,
                    ceilingMicroUsd: request.ceilingMicroUsd,
                    expiresAt: new Date(now.getTime() + request.ttlMs),
                    now,
                });
                const period = spendPeriod(request.startedAt);
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
): Promise<StructuredCallResult<z.infer<S>>> {
    return callStructuredCore({ ...input, requestedById: ctx.userId }, { ...deps, ledger: workspaceAiLedger(ctx) });
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
