/**
 * WHAT A MODEL CALL COSTS, in micro-US-dollars (1 USD = 1 000 000 µUSD).
 *
 * New for Inkquisitor (Phase 2.1). The ONE price table: a row per model family
 * in `./model-capabilities.ts` (a `Record`, so a family without a price fails
 * `tsc`).
 *
 * SOURCE: Anthropic's first-party list prices, "Model pricing" on
 * https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-19.
 * Columns: base input, 5-minute cache write, cache hit (read), output, per
 * million tokens. A price change is an edit here and nowhere else; the date
 * above moves with it.
 *
 * Integer arithmetic, every product rounded UP, so a recorded cost is never
 * below what the provider bills. Batch, fast mode, `inference_geo` and the
 * 1-hour cache write are not priced: this layer sends none of them.
 *
 * ── LONG PROMPTS ────────────────────────────────────────────────────────────
 *
 * Claude Haiku 5.5 is priced by prompt length: a request whose prompt (input,
 * cache writes and cache reads together) is over 100 000 tokens pays the
 * higher row for every token of it. Every other row bills its whole context at
 * one price.
 *
 * ── AN UNKNOWN MODEL IS PRICED AT THE DEAREST RATES ─────────────────────────
 *
 * A deployment may point a tier at a model id the table has no row for
 * (`AI_MODEL_DEEP=…`). Pricing it at zero would let the spend ceiling admit
 * any number of its calls; pricing it at the dearest rate of every column
 * makes the ceiling refuse early rather than late. `UNKNOWN_MODEL_PRICE` is
 * derived from the table, so a dearer row raises it.
 */
import { MODEL_FAMILIES, modelFamilyOf, type ModelFamily } from './model-capabilities';

/** One price row, µUSD per MILLION tokens (so $4 / MTok is 4 000 000). */
export interface PriceRow {
    readonly input: number;
    readonly cacheWrite: number;
    readonly cacheRead: number;
    readonly output: number;
}

export interface ModelPrice extends PriceRow {
    /** The long-prompt row: applies to the whole request when its prompt is over `aboveInputTokens`. */
    readonly longPrompt?: PriceRow & { readonly aboveInputTokens: number };
}

/** The date the table was read from the pricing page. */
export const PRICES_READ_ON = '2026-11-19';

const usd = (dollars: number): number => Math.round(dollars * 1_000_000);
const row = (input: number, cacheWrite: number, cacheRead: number, output: number): PriceRow => ({
    input: usd(input),
    cacheWrite: usd(cacheWrite),
    cacheRead: usd(cacheRead),
    output: usd(output),
});

export const MODEL_PRICES: Readonly<Record<ModelFamily, ModelPrice>> = {
    'claude-fable-5-2': row(8, 10, 0.2, 40),
    'claude-fable-5-1': row(10, 12.5, 0.25, 50),
    'claude-fable-5': row(10, 12.5, 1, 50),
    'claude-opus-5-5': row(4, 5, 0.2, 20),
    'claude-opus-5': row(5, 6.25, 0.5, 25),
    'claude-opus-4-8': row(5, 6.25, 0.5, 25),
    'claude-opus-4-7': row(5, 6.25, 0.5, 25),
    'claude-opus-4-6': row(5, 6.25, 0.5, 25),
    'claude-opus-4-5': row(5, 6.25, 0.5, 25),
    'claude-sonnet-5-5': row(2, 2.5, 0.1, 10),
    'claude-sonnet-5': row(2, 2.5, 0.2, 10),
    'claude-sonnet-4-6': row(3, 3.75, 0.3, 15),
    'claude-sonnet-4-5': row(3, 3.75, 0.3, 15),
    'claude-haiku-5-5': {
        ...row(0.1, 0.125, 0.01, 0.5),
        longPrompt: { ...row(0.5, 0.625, 0.05, 2.5), aboveInputTokens: 100_000 },
    },
    'claude-haiku-4-5': row(1, 1.25, 0.1, 5),
};

/** Every row a model can be billed at: its own and, if it has one, its long-prompt row. */
function rowsOf(p: ModelPrice): PriceRow[] {
    return p.longPrompt ? [p, p.longPrompt] : [p];
}

/** The dearest rate of each column across every row of the table. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = (() => {
    const all = MODEL_FAMILIES.flatMap((f) => rowsOf(MODEL_PRICES[f]));
    return {
        input: Math.max(...all.map((r) => r.input)),
        cacheWrite: Math.max(...all.map((r) => r.cacheWrite)),
        cacheRead: Math.max(...all.map((r) => r.cacheRead)),
        output: Math.max(...all.map((r) => r.output)),
    };
})();

export function priceFor(modelId: string): ModelPrice {
    const family = modelFamilyOf(modelId);
    return family === null ? UNKNOWN_MODEL_PRICE : MODEL_PRICES[family];
}

/** The usage figures one response reports. */
export interface TokenUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheWriteTokens?: number;
    readonly cacheReadTokens?: number;
}

/** `tokens` at `perMTok` µUSD per million, rounded up. Exact in integers up to ~9e9 tokens. */
export function tokensCost(tokens: number, perMTok: number): number {
    if (tokens <= 0) return 0;
    return Math.ceil((tokens * perMTok) / 1_000_000);
}

/** What one response cost, in µUSD, rounded up. */
export function costMicroUsd(modelId: string, usage: TokenUsage): number {
    const price = priceFor(modelId);
    const write = usage.cacheWriteTokens ?? 0;
    const read = usage.cacheReadTokens ?? 0;
    const prompt = usage.inputTokens + write + read;
    const rates: PriceRow = price.longPrompt && prompt > price.longPrompt.aboveInputTokens ? price.longPrompt : price;
    return (
        tokensCost(usage.inputTokens, rates.input) +
        tokensCost(write, rates.cacheWrite) +
        tokensCost(read, rates.cacheRead) +
        tokensCost(usage.outputTokens, rates.output)
    );
}

/**
 * The most a call can cost before it is made. `inputTokens` and
 * `outputTokens` are UPPER BOUNDS (the prompt's UTF-8 byte count, which no
 * token is shorter than, and `max_tokens`); every input token is priced at the
 * dearer of the input and cache-write rates (the system block is marked for
 * caching, and a write costs more than a plain read of input), and the
 * long-prompt row applies when the bound could cross its threshold.
 */
export function worstCaseCostMicroUsd(modelId: string, bounds: { inputTokens: number; outputTokens: number }): number {
    const price = priceFor(modelId);
    const rates: PriceRow =
        price.longPrompt && bounds.inputTokens > price.longPrompt.aboveInputTokens ? price.longPrompt : price;
    return (
        tokensCost(bounds.inputTokens, Math.max(rates.input, rates.cacheWrite)) +
        tokensCost(bounds.outputTokens, rates.output)
    );
}

/**
 * The web search server tool's fee (Phase 2.6): $10 per 1,000 searches on the
 * Claude API ("Web search tool", Usage and pricing, read 2026-11-20), so
 * 10 000 µUSD a search, on top of the tokens its results add. Web fetch has no
 * fee of its own (its content is billed as input tokens). A search that fails
 * still counts against `max_uses`; the provider's `server_tool_use` usage
 * reports the billed requests, and that count is what is charged.
 */
export const WEB_SEARCH_MICRO_USD_PER_REQUEST = 10_000;
export const PRICES_WEB_TOOLS_READ_ON = '2026-11-20';

/** What `searches` web searches cost, in µUSD. */
export function webSearchCostMicroUsd(searches: number): number {
    return searches > 0 ? searches * WEB_SEARCH_MICRO_USD_PER_REQUEST : 0;
}
