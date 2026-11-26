/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between bible fact extraction (4.1) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultBibleFactExtractor(ctx)` is 4.0's `FactExtractor` contract over the
 * workspace-bound `callStructured` with BIBLE_FACTS_PROMPT and
 * `BibleFactsOutputSchema`: one call per accepted version, reserved against the
 * monthly ceiling before it is sent. 2.1's outcomes map to the extraction's
 * exactly as they do to a chunk's (`extractOutcomeOf`, the table in
 * `src/lib/sources/model-seam.ts`): KILL_SWITCH, WORKSPACE_CEILING and
 * AI_UNAVAILABLE stop the run, resumable; GUARD_REFUSED yields nothing; the
 * rest are the call's own failure. The extraction's usecase checks that the
 * version's author may still edit the bible (`bible.edit`) before any call.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured } from '@/app-layer/usecases/model-calls';
import type { StructuredCallDeps, StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import type { FactExtractor } from '@/lib/sources/extractor';
import { extractOutcomeOf } from '@/lib/sources/model-seam';
import { BIBLE_FACTS_PROMPT } from './prompt';
import { BibleFactsOutputSchema } from './schema';

/** One structured call with the workspace bound (the deployment's, or a test's over the fake Messages API). */
export type BibleFactsCaller = (input: Omit<StructuredCallInput<typeof BibleFactsOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

export function bibleFactExtractorOver(call: BibleFactsCaller): FactExtractor {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await call({ template: BIBLE_FACTS_PROMPT, data: request.data, schema: BibleFactsOutputSchema, bookId: request.bookId, signal });
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                return extractOutcomeOf(err);
            }
        },
    } satisfies FactExtractor);
}

/** The deployment's extractor, in the context's workspace, as its user. `deps` is the tests' fetch seam. */
export function defaultBibleFactExtractor(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}): FactExtractor {
    return bibleFactExtractorOver((input) => callStructured(ctx, input, deps));
}
