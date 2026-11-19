/**
 * THE MODEL TIERS — the one file that says which model does what.
 *
 * New for Inkquisitor (Phase 2.1); the deployment-chooses-the-model rule is
 * inflect-compliance's (`toolRunnerModelFor` in
 * `src/lib/agentic/tool-runner/client.ts`): a feature names a TIER, never a
 * model id, so nothing an author or a prompt writes can pick a model this
 * deployment does not offer.
 *
 *   fast      classification, extraction      claude-haiku-5-5   effort low
 *   balanced  question generation             claude-sonnet-5-5  effort medium
 *   deep      book-level analysis             claude-opus-5-5    effort high
 *
 * Each tier's MODEL is overridable by `AI_MODEL_FAST` / `AI_MODEL_BALANCED` /
 * `AI_MODEL_DEEP` (optional; an unknown model id is priced at the dearest
 * rates and sent only what every model accepts, see `./pricing.ts` and
 * `./model-capabilities.ts`). The rest of a tier is code:
 *
 *   maxOutputTokens  `max_tokens` of every request. It bounds thinking and
 *                    answer together, and it is the output half of the worst
 *                    case the spend ceiling checks. A prompt template may ask
 *                    for LESS, never more (`./prompt.ts`).
 *   timeoutMs        the hard deadline of one `callStructured`, repair and the
 *                    SDK's retries included: past it the request is aborted
 *                    and the call ends TIMEOUT.
 *   effort           `output_config.effort`, where the model's row accepts it.
 *
 * The defaults are the current generation's three models (claude-api skill,
 * model table cached 2026-11-03; pricing read 2026-11-19).
 */
import { env } from '@/env';

export const MODEL_TIERS = ['fast', 'balanced', 'deep'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type Effort = 'low' | 'medium' | 'high';

export interface TierDefaults {
    readonly model: string;
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
    readonly effort: Effort;
}

export const TIER_DEFAULTS: Readonly<Record<ModelTier, TierDefaults>> = {
    fast: { model: 'claude-haiku-5-5', maxOutputTokens: 4_096, timeoutMs: 60_000, effort: 'low' },
    balanced: { model: 'claude-sonnet-5-5', maxOutputTokens: 16_000, timeoutMs: 180_000, effort: 'medium' },
    deep: { model: 'claude-opus-5-5', maxOutputTokens: 32_000, timeoutMs: 600_000, effort: 'high' },
};

/** The env variable that overrides each tier's model. */
export const TIER_MODEL_ENV: Readonly<Record<ModelTier, 'AI_MODEL_FAST' | 'AI_MODEL_BALANCED' | 'AI_MODEL_DEEP'>> = {
    fast: 'AI_MODEL_FAST',
    balanced: 'AI_MODEL_BALANCED',
    deep: 'AI_MODEL_DEEP',
};

/** A model id as the API spells one: lower-case words, digits, dots and dashes. */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,99}$/;

/**
 * The model a tier runs on: the deployment's override, else the default. A
 * malformed override is ignored (with the default used), never sent: the env
 * schema refuses it in a validated process, and this is the second line.
 */
export function modelForTier(tier: ModelTier): string {
    const configured = env[TIER_MODEL_ENV[tier]]?.trim();
    return configured && MODEL_ID_PATTERN.test(configured) ? configured : TIER_DEFAULTS[tier].model;
}
