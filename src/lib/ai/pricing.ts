/**
 * WHAT A MODEL CALL COSTS, in micro-US-dollars (1 USD = 1 000 000 µUSD).
 *
 * New for Inkquisitor (Phase 2.1). One row per model family in
 * `./model-capabilities.ts`, from Anthropic's first-party list prices (USD
 * per million tokens, read 2026-11-18). Integer arithmetic throughout, rounded
 * UP, so a recorded cost is never below what the provider bills.
 *
 * ── AN UNKNOWN MODEL IS PRICED AT THE MOST EXPENSIVE ROW ────────────────────
 *
 * A deployment may point a tier at a model id this table has no row for
 * (`AI_MODEL_DEEP=…`). Pricing it at zero would let the spend ceiling admit
 * any number of calls to it; pricing it at the dearest row makes the ceiling
 * refuse early instead of late. `UNKNOWN_MODEL_PRICE` is derived from the
 * table, so a dearer row raises it.
 *
 * ── CACHE TOKENS ────────────────────────────────────────────────────────────
 *
 * This layer sends no `cache_control`, so cache counts are normally zero. When
 * the provider reports some, writes are priced at 1.25× input (the 5-minute
 * write rate) and reads at 0.1× input, an upper bound for every row (the 5.x
 * models read at 0.025×–0.05×).
 */
import { MODEL_FAMILIES, modelFamilyOf, type ModelFamily } from './model-capabilities';

/** List price in micro-USD per MILLION tokens (so $4 / MTok is 4 000 000). */
export interface ModelPrice {
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
    /**
     * A long-prompt rate: when a request's input exceeds `aboveInputTokens`,
     * every token of it is billed at these rates instead (Claude Haiku 5.5).
     */
    readonly longPrompt?: {
        readonly aboveInputTokens: number;
        readonly inputPerMTok: number;
        readonly outputPerMTok: number;
    };
}

const usd = (dollars: number): number => Math.round(dollars * 1_000_000);
const row = (input: number, output: number): ModelPrice => ({ inputPerMTok: usd(input), outputPerMTok: usd(output) });

export const MODEL_PRICES: Readonly<Record<ModelFamily, ModelPrice>> = {
    'claude-fable-5-2': row(8, 40),
    'claude-fable-5-1': row(10, 50),
    'claude-fable-5': row(10, 50),
    'claude-opus-5-5': row(4, 20),
    'claude-opus-5': row(5, 25),
    'claude-opus-4-8': row(5, 25),
    'claude-opus-4-7': row(5, 25),
    'claude-opus-4-6': row(5, 25),
    'claude-opus-4-5': row(5, 25),
    'claude-sonnet-5-5': row(2, 10),
    'claude-sonnet-5': row(2, 10),
    'claude-sonnet-4-6': row(3, 15),
    'claude-sonnet-4-5': row(3, 15),
    'claude-haiku-5-5': {
        ...row(0.1, 0.5),
        longPrompt: { aboveInputTokens: 100_000, inputPerMTok: usd(0.5), outputPerMTok: usd(2.5) },
    },
    'claude-haiku-4-5': row(1, 5),
};

/** The rates a model is charged at, at most, whatever the prompt length. */
function ceilingRates(p: ModelPrice): { input: number; output: number } {
    return {
        input: Math.max(p.inputPerMTok, p.longPrompt?.inputPerMTok ?? 0),
        output: Math.max(p.outputPerMTok, p.longPrompt?.outputPerMTok ?? 0),
    };
}

/** The dearest row of the table, used for a model it does not name. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = (() => {
    let input = 0;
    let output = 0;
    for (const family of MODEL_FAMILIES) {
        const r = ceilingRates(MODEL_PRICES[family]);
        input = Math.max(input, r.input);
        output = Math.max(output, r.output);
    }
    return { inputPerMTok: input, outputPerMTok: output };
})();

export function priceFor(modelId: string): ModelPrice {
    const family = modelFamilyOf(modelId);
    return family === null ? UNKNOWN_MODEL_PRICE : MODEL_PRICES[family];
}

/** The usage figures one response reports. */
export interface TokenUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreationInputTokens?: number;
    readonly cacheReadInputTokens?: number;
}

const perToken = (tokens: number, perMTok: number): number => Math.ceil((tokens * perMTok) / 1_000_000);

/** What one response cost, in micro-USD, rounded up. */
export function costMicroUsd(modelId: string, usage: TokenUsage): number {
    const price = priceFor(modelId);
    const write = usage.cacheCreationInputTokens ?? 0;
    const read = usage.cacheReadInputTokens ?? 0;
    const promptTokens = usage.inputTokens + write + read;
    const long = price.longPrompt && promptTokens > price.longPrompt.aboveInputTokens ? price.longPrompt : null;
    const inRate = long ? long.inputPerMTok : price.inputPerMTok;
    const outRate = long ? long.outputPerMTok : price.outputPerMTok;
    return (
        perToken(usage.inputTokens, inRate) +
        perToken(write * 5, inRate / 4) + // 1.25× input
        perToken(read, inRate / 10) + // 0.1× input
        perToken(usage.outputTokens, outRate)
    );
}

/**
 * The most a call can cost before it is made: `inputTokens` and `outputTokens`
 * are upper bounds, and the dearest rate the model has is applied to both.
 */
export function worstCaseCostMicroUsd(modelId: string, bounds: { inputTokens: number; outputTokens: number }): number {
    const r = ceilingRates(priceFor(modelId));
    return perToken(bounds.inputTokens, r.input) + perToken(bounds.outputTokens, r.output);
}
