/**
 * Integration fixtures for the model layer's ledger (Phase 2.1): model calls
 * made through the product's own path — `callStructured` in
 * `src/app-layer/usecases/model-calls.ts`, bound to the workspace's ledger —
 * against the fake Messages API, so a fixture row is exactly what a real call
 * leaves and no test reaches a network.
 */
import { z } from 'zod';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured, workspaceAiLedger } from '@/app-layer/usecases/model-calls';
import { definePrompt } from '@/lib/ai/prompt';
import { fakeAnthropic, setFakeApiKey } from './fake-anthropic';

export const SEED_TEMPLATE = definePrompt({
    id: 'test.seed',
    version: '1',
    purpose: 'seed',
    tier: 'fast',
    system: 'You answer with a short JSON object.',
    task: 'Name one thing about the material below.',
});

export const SEED_SCHEMA = z.object({ thing: z.string() });

/** One recorded OK call (an `AiCallLog` row and the month's spend) in the context's workspace. */
export async function seedAiCall(ctx: WorkspaceRequestContext, bookId: string | null, marker = 'seed'): Promise<string> {
    const restore = setFakeApiKey();
    try {
        const api = fakeAnthropic([{ kind: 'text', text: JSON.stringify({ thing: `a ${marker}` }), usage: { input_tokens: 500, output_tokens: 50 } }]);
        const result = await callStructured(
            ctx,
            { template: SEED_TEMPLATE, data: [{ label: 'note', text: `Material ${marker}.` }], schema: SEED_SCHEMA, bookId },
            { fetch: api.fetch, env: {} },
        );
        return result.callId;
    } finally {
        restore();
    }
}

/** A live reservation of `amountMicroUsd` in the context's workspace (a call that has not settled). */
export async function seedReservation(ctx: WorkspaceRequestContext, callId: string, amountMicroUsd = 1_000): Promise<void> {
    const held = await workspaceAiLedger(ctx).reserve({
        callId,
        amountMicroUsd,
        ceilingMicroUsd: Number.MAX_SAFE_INTEGER,
        ttlMs: 60 * 60 * 1000,
        startedAt: new Date(),
    });
    if (!held.ok) throw new Error('seed reservation refused');
}
