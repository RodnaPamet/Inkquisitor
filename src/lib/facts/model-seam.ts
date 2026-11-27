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
import { callStructured, type NightlyShare } from '@/app-layer/usecases/model-calls';
import { AiSpendCeilingError } from '@/lib/ai/errors';
import type { StructuredCallDeps, StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import type { FactExtractor } from '@/lib/sources/extractor';
import { extractOutcomeOf } from '@/lib/sources/model-seam';
import { BIBLE_FACTS_PROMPT } from './prompt';
import { BibleFactsOutputSchema } from './schema';

/** One structured call with the workspace bound (the deployment's, or a test's over the fake Messages API). */
export type BibleFactsCaller = (input: Omit<StructuredCallInput<typeof BibleFactsOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

/** 4.H-b (D32): the sub-purpose a BACKFILL extraction's calls are recorded and shared under (its daily share is measured by it). */
export const BIBLE_FACTS_BACKFILL_PURPOSE = 'facts.bible-extract.backfill';

/** The error code a call refused at the backfill's daily share carries (`extractOutcomeOf`'s WORKSPACE_CEILING otherwise). */
export const DAILY_SHARE_REFUSED = 'DAILY_SHARE';
/** The error code a call refused at the backfill's share of the calendar month carries (D32, owner decision 2026-11-27). */
export const MONTHLY_SHARE_REFUSED = 'MONTHLY_SHARE';

export function bibleFactExtractorOver(call: BibleFactsCaller, options: { purpose?: string } = {}): FactExtractor {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await call({ template: BIBLE_FACTS_PROMPT, data: request.data, schema: BibleFactsOutputSchema, bookId: request.bookId, signal, ...(options.purpose ? { purpose: options.purpose } : {}) });
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                // The backfill's daily or monthly share (D32), refused by the ledger under its lock: named apart from the ceiling.
                const limit = err instanceof AiSpendCeilingError ? (err.details as { limit?: unknown } | undefined)?.limit : undefined;
                const outcome = extractOutcomeOf(err);
                if (outcome.ok) return outcome;
                if (limit === 'MONTHLY_SHARE') return { ...outcome, errorCode: MONTHLY_SHARE_REFUSED };
                if (limit === 'NIGHTLY_SHARE') return { ...outcome, errorCode: DAILY_SHARE_REFUSED };
                return outcome;
            }
        },
    } satisfies FactExtractor);
}

/**
 * The deployment's extractor, in the context's workspace, as its user. `deps` is the tests' fetch seam. A BACKFILL
 * extraction (4.H-b, D32) passes its `shares` (the daily share and the share of the calendar month, one purpose): its
 * calls are recorded under `BIBLE_FACTS_BACKFILL_PURPOSE` and each reservation is held to both by the ledger, under
 * its spend lock.
 */
export function defaultBibleFactExtractor(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}, shares: readonly NightlyShare[] = []): FactExtractor {
    return bibleFactExtractorOver((input) => callStructured(ctx, input, deps, { share: shares }), { purpose: shares[0]?.purpose });
}
