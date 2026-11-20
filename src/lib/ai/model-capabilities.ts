/**
 * WHICH REQUEST PARAMETERS EACH MODEL ACCEPTS.
 *
 * Adapted from inflect-compliance's
 * `src/lib/agentic/tool-runner/model-capabilities.ts` (see
 * docs/carve-manifest.md). The pattern is inflect's: a closed table of model
 * families, a `Record` so a family added to the list without a row fails
 * `tsc`, a family matched by its id alone or with a dated snapshot suffix, and
 * an unknown model that fails CLOSED to the request every model accepts. The
 * columns are this layer's: inflect's `fallbacks` column is dropped (a refusal
 * here is a typed error, never a silent re-run on a model nobody chose), and
 * `structuredOutput` decides how `callStructured` asks for its answer.
 *
 * ── THE TABLE IS DATA, `buildModelRequest` IS THE SHAPE ─────────────────────
 *
 * Nothing here builds a request. `./prompt.ts` reads the row of the model a
 * call resolved and sends each governed parameter only where the row says so:
 *
 *   effort            `output_config.effort` (`low`, `medium`, `high`). Every
 *                     row from the 4.5 Opus and the 4.6 generation on.
 *   structuredOutput  `output_config.format` with a JSON schema is accepted:
 *                     the API's structured-output feature, `callStructured`'s
 *                     primary path. TRUE only for a family on the Claude API's
 *                     structured-outputs model list (read 2026-11-19 from
 *                     platform.claude.com/docs/en/build-with-claude/structured-outputs).
 *                     Opus 4.6 / 4.7 and Sonnet 4.5 / 4.6 are NOT on it
 *                     (issue #32, item 14): their rows say false, so a
 *                     deployment overriding a tier to one of them takes the
 *                     single-tool path every model accepts, never a 400.
 *                     A model with no row takes the tool path too.
 *
 * `thinking` is not a column: no request this layer builds sends it. Every
 * model from the 4.6 generation on thinks adaptively when the parameter is
 * omitted (Opus 5.5 and Sonnet 5.5 refuse `disabled`; a budget is removed on
 * the 4.7-and-later models), so omitting it is the one value every row
 * accepts, and `effort` is the dial. The older budget-thinking rows simply do
 * not think.
 *
 * ── AN UNKNOWN MODEL FAILS CLOSED ───────────────────────────────────────────
 *
 * A model id with no row (a deployment's `AI_MODEL_*` override naming a model
 * released after this table) gets `CONSERVATIVE_CAPABILITIES`: no effort and
 * no structured output, so its call takes the single-tool path with
 * `tool_choice: auto` — a request every current model accepts. A forced
 * `tool_choice` is never sent: Claude Opus 5.5, Sonnet 5.5 and the Fable 5.1 /
 * 5.2 family refuse it with a 400. Fail closed means "send what every model
 * takes", not "refuse the call".
 */

export interface ModelCapabilities {
    /** `output_config.effort` at `low`, `medium` and `high`. */
    readonly effort: boolean;
    /** `output_config.format` with a JSON schema. */
    readonly structuredOutput: boolean;
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

const FULL: ModelCapabilities = { effort: true, structuredOutput: true };
const NO_EFFORT: ModelCapabilities = { effort: false, structuredOutput: true };
/** Effort, but not on the structured-outputs list: the single-tool path. */
const EFFORT_TOOL_PATH: ModelCapabilities = { effort: true, structuredOutput: false };
/** Neither: the conservative request. */
const TOOL_PATH: ModelCapabilities = { effort: false, structuredOutput: false };

/** One row per family. A `Record`, so a family added to the list without a row fails `tsc`. */
export const MODEL_CAPABILITIES: Readonly<Record<ModelFamily, ModelCapabilities>> = {
    'claude-fable-5-2': FULL,
    'claude-fable-5-1': FULL,
    'claude-fable-5': FULL,
    'claude-opus-5-5': FULL,
    'claude-opus-5': FULL,
    'claude-opus-4-8': FULL,
    'claude-opus-4-7': EFFORT_TOOL_PATH,
    'claude-opus-4-6': EFFORT_TOOL_PATH,
    'claude-opus-4-5': FULL,
    'claude-sonnet-5-5': FULL,
    'claude-sonnet-5': FULL,
    'claude-sonnet-4-6': EFFORT_TOOL_PATH,
    'claude-sonnet-4-5': TOOL_PATH,
    'claude-haiku-5-5': FULL,
    'claude-haiku-4-5': NO_EFFORT,
};

/** What a model with no row is sent: only what every current model accepts. */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = { effort: false, structuredOutput: false };

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
