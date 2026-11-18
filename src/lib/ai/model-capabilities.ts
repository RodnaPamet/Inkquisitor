/**
 * WHICH REQUEST PARAMETERS EACH MODEL ACCEPTS.
 *
 * Adapted from inflect-compliance's `src/lib/agentic/tool-runner/model-capabilities.ts`
 * (see docs/carve-manifest.md). The pattern is inflect's: a closed table of
 * model families, a `Record` so a family without a row fails `tsc`, and an
 * unknown model that fails CLOSED to the parameters every model accepts. The
 * columns are this layer's: inflect's `fallbacks` column is dropped (a
 * refusal here is a typed error, never a silent re-run on a model nobody
 * chose), and two columns decide how structured output is asked for.
 *
 * ── THE TABLE IS DATA, `buildModelRequest` IS THE SHAPE ─────────────────────
 *
 * Nothing here builds a request. `./prompt.ts` reads the row of the model a
 * call resolved and sends each governed parameter only where the row says the
 * model accepts it.
 *
 *   thinking 'adaptive'  `thinking: { type: 'adaptive' }` is sent. Every model
 *                        from the 4.6 generation on. Never sent with a forced
 *                        tool choice, which thinking does not allow.
 *   thinking 'budget'    the model takes only `{ type: 'enabled',
 *                        budget_tokens: N }`; this layer sends it NO thinking
 *                        configuration (a budget is a number nobody chose).
 *   effort               `output_config.effort` at `low`, `medium`, `high`.
 *   structuredOutput     `output_config.format` (JSON schema) is accepted: the
 *                        primary path of `callStructured`. The rows follow the
 *                        Claude API's structured-outputs model list (read
 *                        2026-11-18); a model it does not list is treated as
 *                        not supporting it and takes the tool path.
 *   forcedToolChoice     `tool_choice: { type: 'tool', name }` is accepted.
 *                        Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 / 5.2 refuse
 *                        it with a 400, so on those the tool path (only ever
 *                        reached if structured output were unavailable) asks
 *                        with `auto` and code checks the call was made.
 *
 * ── AN UNKNOWN MODEL FAILS CLOSED ───────────────────────────────────────────
 *
 * A model id with no row gets `CONSERVATIVE_CAPABILITIES`: no thinking
 * configuration, no effort, no structured output and no forced tool choice —
 * one tool offered with `tool_choice: auto`. That is the request every current
 * model accepts. A row is matched by its family id, alone or followed by a
 * dated snapshot suffix (`claude-haiku-4-5-20251001`); `claude-opus-5` is not a
 * prefix match for `claude-opus-5-5`.
 */

/** How a model accepts a thinking configuration. */
export type ThinkingSupport = 'adaptive' | 'budget' | 'none';

export interface ModelCapabilities {
    /** The thinking configuration the model accepts. Only 'adaptive' is ever sent. */
    readonly thinking: ThinkingSupport;
    /** `output_config.effort` at `low`, `medium` and `high`. */
    readonly effort: boolean;
    /** `output_config.format` with a JSON schema. */
    readonly structuredOutput: boolean;
    /** `tool_choice` of type `tool` (or `any`). */
    readonly forcedToolChoice: boolean;
}

/** The model families this layer has a row for. A closed list: a new family is a reviewed row. */
export const MODEL_FAMILIES = [
    'claude-fable-5-2',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-5-5',
    'claude-haiku-4-5',
] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** Structured output, effort and adaptive thinking; forced tool choice refused. */
const CURRENT_NO_FORCED: ModelCapabilities = {
    thinking: 'adaptive',
    effort: true,
    structuredOutput: true,
    forcedToolChoice: false,
};
const CURRENT: ModelCapabilities = { ...CURRENT_NO_FORCED, forcedToolChoice: true };
/** Adaptive thinking and effort, but not on the structured-outputs list. */
const ADAPTIVE_NO_STRUCTURED: ModelCapabilities = {
    thinking: 'adaptive',
    effort: true,
    structuredOutput: false,
    forcedToolChoice: true,
};

/** One row per family. A `Record`, so a family added to the list without a row fails `tsc`. */
export const MODEL_CAPABILITIES: Readonly<Record<ModelFamily, ModelCapabilities>> = {
    'claude-fable-5-2': CURRENT_NO_FORCED,
    'claude-fable-5-1': CURRENT_NO_FORCED,
    'claude-fable-5': CURRENT,
    'claude-opus-5-5': CURRENT_NO_FORCED,
    'claude-opus-5': CURRENT,
    'claude-opus-4-8': CURRENT,
    'claude-opus-4-7': ADAPTIVE_NO_STRUCTURED,
    'claude-opus-4-6': ADAPTIVE_NO_STRUCTURED,
    'claude-opus-4-5': { thinking: 'budget', effort: true, structuredOutput: true, forcedToolChoice: true },
    'claude-sonnet-5-5': CURRENT_NO_FORCED,
    'claude-sonnet-5': CURRENT,
    'claude-sonnet-4-6': ADAPTIVE_NO_STRUCTURED,
    'claude-sonnet-4-5': { thinking: 'budget', effort: false, structuredOutput: false, forcedToolChoice: true },
    'claude-haiku-5-5': CURRENT,
    'claude-haiku-4-5': { thinking: 'budget', effort: false, structuredOutput: true, forcedToolChoice: true },
};

/** What a model with no row is sent: only what every current model accepts. */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = {
    thinking: 'none',
    effort: false,
    structuredOutput: false,
    forcedToolChoice: false,
};

/** A dated snapshot of a family: `-` and eight digits, nothing else. */
const SNAPSHOT_SUFFIX = /^-\d{8}$/;

/** The family a model id belongs to, or null when no row names it. */
export function modelFamilyOf(modelId: string): ModelFamily | null {
    const id = modelId.trim();
    for (const family of MODEL_FAMILIES) {
        if (id === family) return family;
        if (id.startsWith(family) && SNAPSHOT_SUFFIX.test(id.slice(family.length))) return family;
    }
    return null;
}

/** The parameters `modelId` accepts: its family's row, or the conservative set. */
export function modelCapabilitiesFor(modelId: string): ModelCapabilities {
    const family = modelFamilyOf(modelId);
    return family === null ? CONSERVATIVE_CAPABILITIES : MODEL_CAPABILITIES[family];
}
