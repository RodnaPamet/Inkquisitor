/**
 * ════════════════════════════════════════════════════════════════════
 *  THE WIRING SEAM between the interview's tie-break (4.4) and the model layer (2.1)
 * ════════════════════════════════════════════════════════════════════
 *
 * `defaultQuestionOrderer(ctx)` is 4.0's call contract (`FactExtractor`) over
 * the workspace-bound `callStructured` with QUESTION_ORDER_PROMPT and
 * `QuestionOrderOutputSchema`: one fast call, reserved against the monthly
 * ceiling before it is sent and refused by the kill switch, its data
 * guard-scanned and fenced, recorded in `AiCallLog`, its failure named
 * (`extractOutcomeOf`). Any failure leaves the code's order standing.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { callStructured } from '@/app-layer/usecases/model-calls';
import type { StructuredCallDeps, StructuredCallInput, StructuredCallResult } from '@/lib/ai/call-structured';
import type { FactExtractor } from '@/lib/sources/extractor';
import { extractOutcomeOf } from '@/lib/sources/model-seam';
import { QUESTION_ORDER_PROMPT } from './prompt';
import { QuestionOrderOutputSchema } from './schema';

export type QuestionOrderer = FactExtractor;

export type QuestionOrderCaller = (input: Omit<StructuredCallInput<typeof QuestionOrderOutputSchema>, 'requestedById'>) => Promise<StructuredCallResult<unknown>>;

/** The tie-break call over any caller (the deployment's below; the injection suite's compromised one). */
export function questionOrdererOver(call: QuestionOrderCaller): QuestionOrderer {
    return Object.freeze({
        async extract(request, signal) {
            try {
                const r = await call({ template: QUESTION_ORDER_PROMPT, data: request.data, schema: QuestionOrderOutputSchema, bookId: request.bookId, signal });
                return { ok: true as const, output: r.value, tokensUsed: r.tokensUsed, costMicroUsd: r.costMicroUsd, callIds: [r.callId] };
            } catch (err) {
                return extractOutcomeOf(err);
            }
        },
    } satisfies QuestionOrderer);
}

export function defaultQuestionOrderer(ctx: WorkspaceRequestContext, deps: Pick<StructuredCallDeps, 'fetch' | 'timeoutMs'> = {}): QuestionOrderer {
    return questionOrdererOver((input) => callStructured(ctx, input, deps));
}
