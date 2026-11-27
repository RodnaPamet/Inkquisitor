/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between the nightly draft reading (5.3) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultDraftReader(ctx, deps, share)` is a `FactExtractor` (4.0's contract) over the workspace-bound
 * `callStructured`: DRAFT_READ_PROMPT, `DraftReadOutputSchema`, one call per piece of a scene, each reserved against the
 * monthly ceiling AND the night's share (D35 item 2: draft reading and the continuity check together) before it is
 * sent. Calling the model needs no permission of its own: the run's usecase acts as a member who may edit the bible.
 *
 * ── 2.1 OUTCOME → THE PIECE ──────────────────────────────────────────────── (4.0's table, `extractOutcomeOf`)
 *
 *   OK, REPAIRED              the output, tokens, call id, cost
 *   KILLED (AI_DISABLED)      KILL_SWITCH: the night stops, resumable
 *   CEILING                   WORKSPACE_CEILING: the night stops CEILING — or NIGHTLY_CAP when the ledger refused the
 *                             night's share (`NIGHTLY_SHARE_REFUSED`), resumable
 *   by configuration          AI_UNAVAILABLE: the night stops
 *   REFUSED_GUARD             GUARD_REFUSED: the piece yields nothing (its text tripped the guard)
 *   TIMEOUT, PROVIDER_ERROR   the scene is left for the next night
 *   INVALID_OUTPUT            the scene is left for the next night (passed over after `DRAFT_SCENE_FAILURES_MAX`)
 *   AiPromptError             PROMPT_INVALID: `REPEATS_PROMPT` (the piece repeats a sentence of the prompt) yields nothing
 *
 * D3: this module returns model output to its caller and writes nothing; nothing it reaches writes a scene's text.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured, type NightlyShare } from '@/app-layer/usecases/model-calls';
import { AiSpendCeilingError } from '@/lib/ai/errors';
import type { StructuredCallDeps, StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import type { FactExtractor } from '@/lib/sources/extractor';
import { extractOutcomeOf } from '@/lib/sources/model-seam';
import { DRAFT_READ_PROMPT } from './prompt';
import { DraftReadOutputSchema } from './schema';

/** A draft read is one structured call: the same contract as 4.0's extractor. */
export type DraftReader = FactExtractor;

/** The error code a call refused at the night's share carries (`extractOutcomeOf`'s WORKSPACE_CEILING otherwise). */
export const DRAFT_NIGHTLY_SHARE_REFUSED = 'NIGHTLY_SHARE';

export type DraftReadCaller = (input: Omit<StructuredCallInput<typeof DraftReadOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

export function draftReaderOver(call: DraftReadCaller): DraftReader {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await call({ template: DRAFT_READ_PROMPT, data: request.data, schema: DraftReadOutputSchema, bookId: request.bookId, signal });
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                const share = err instanceof AiSpendCeilingError && (err.details as { limit?: unknown } | undefined)?.limit === 'NIGHTLY_SHARE';
                const outcome = extractOutcomeOf(err);
                return share && !outcome.ok ? { ...outcome, errorCode: DRAFT_NIGHTLY_SHARE_REFUSED } : outcome;
            }
        },
    } satisfies DraftReader);
}

/** The deployment's reader, in the context's workspace, as its user, held to the night's share. `deps` is the tests' fetch seam. */
export function defaultDraftReader(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}, share?: NightlyShare): DraftReader {
    return draftReaderOver((input) => callStructured(ctx, input, deps, { share }));
}
