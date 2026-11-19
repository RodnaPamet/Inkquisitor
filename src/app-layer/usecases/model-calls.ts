/**
 * Model calls for a workspace (Phase 2.1): `callStructured` bound to the
 * workspace's ledger. Every model feature (the question engine of 2.2, the
 * enrichment of 2.5, the research run of 2.6) calls a model through here, from
 * its own usecase, after its own permission check: calling the model is not a
 * permission of its own, it is part of whatever the feature does.
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
import {
    callStructured as callStructuredCore,
    type StructuredCallDeps,
    type StructuredCallInput,
    type StructuredCallResult,
} from '@/lib/ai/call-structured';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';

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
