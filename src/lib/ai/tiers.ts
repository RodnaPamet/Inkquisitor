/**
 * THE MODEL TIERS — the one file that says which model does what.
 *
 * New for Inkquisitor (Phase 2.1); the deployment-chooses-the-model rule is
 * inflect-compliance's (`toolRunnerModelFor` in
 * `src/lib/agentic/tool-runner/client.ts`): a feature names a TIER, never a
 * model id, so nothing an author or a prompt writes can pick a model this
 * deployment does not offer.
 *
 *   fast      classification and extraction          default claude-haiku-5-5
 *   balanced  question generation                    default claude-sonnet-5-5
 *   deep      book-level analysis                    default claude-opus-5-5
 *
 * Each model is overridable by `AI_MODEL_FAST` / `AI_MODEL_BALANCED` /
 * `AI_MODEL_DEEP`, and each tier's per-call output budget by
 * `AI_MAX_OUTPUT_TOKENS_FAST` / `_BALANCED` / `_DEEP`. A prompt template may
 * ask for LESS than its tier's budget, never more (`./prompt.ts`). The budget
 * is `max_tokens`, so it bounds thinking and answer together, and it is what
 * the worst-case cost of a call — the figure the spend ceiling checks — is
 * computed from.
 */
import { env } from '@/env';

export const MODEL_TIERS = ['fast', 'balanced', 'deep'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type Effort = 'low' | 'medium' | 'high';

export interface TierDefaults {
    readonly model: string;
    readonly maxOutputTokens: number;
    /** Sent as `output_config.effort` where the model's row accepts it. */
    readonly effort: Effort;
}

export const TIER_DEFAULTS: Readonly<Record<ModelTier, TierDefaults>> = {
    fast: { model: 'claude-haiku-5-5', maxOutputTokens: 4_096, effort: 'low' },
    balanced: { model: 'claude-sonnet-5-5', maxOutputTokens: 16_000, effort: 'medium' },
    deep: { model: 'claude-opus-5-5', maxOutputTokens: 32_000, effort: 'high' },
};

function positiveInt(value: string | undefined): number | null {
    if (value === undefined) return null;
    const n = Number(value.trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** The model a tier runs on: the deployment's override, else the default. */
export function modelForTier(tier: ModelTier): string {
    const configured: Record<ModelTier, string | undefined> = {
        fast: env.AI_MODEL_FAST,
        balanced: env.AI_MODEL_BALANCED,
        deep: env.AI_MODEL_DEEP,
    };
    return configured[tier]?.trim() || TIER_DEFAULTS[tier].model;
}

/** A tier's per-call output budget (`max_tokens`): the deployment's override, else the default. */
export function maxOutputTokensForTier(tier: ModelTier): number {
    const configured: Record<ModelTier, string | undefined> = {
        fast: env.AI_MAX_OUTPUT_TOKENS_FAST,
        balanced: env.AI_MAX_OUTPUT_TOKENS_BALANCED,
        deep: env.AI_MAX_OUTPUT_TOKENS_DEEP,
    };
    return positiveInt(configured[tier]) ?? TIER_DEFAULTS[tier].maxOutputTokens;
}
