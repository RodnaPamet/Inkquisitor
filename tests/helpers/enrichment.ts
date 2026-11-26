/**
 * Integration fixtures for enrichment (Phase 2.5): reconcilers a test hands
 * the usecases instead of the deployment's, and a seeded interview whose first
 * round is answered, closed and reconciled through the product's own usecases.
 *
 *   stubReconciler()     the loopback stub's own reconcile answer (2.4's D13
 *                        stub, `stubReconcileAnswer`): an ADD of the answer's
 *                        words into each empty field an answer targeted
 *   scripted(fn)         a reconciler answering `fn(facts)`, where facts are
 *                        the request's real element and answer ids
 *   failing(outcome)     a reconciler whose every call fails with `outcome`
 *
 * No model is called and nothing reaches the network.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { answerQuestion } from '@/app-layer/usecases/interview-answers';
import { startInterview } from '@/app-layer/usecases/interviews';
import { closeRoundAndReconcile, type EnrichmentDeps } from '@/app-layer/usecases/enrichment-reconcile';
import { stubReconcileAnswer } from '@/lib/ai/model-stub';
import type { ReconcileRequest } from '@/lib/enrichment/prompt';
import type { ReconcileCallFailure, Reconciler } from '@/lib/enrichment/reconciler';
import { fakeGenerator } from './fake-question-generator';
import { FRONTIER_ONLY, stubQuestionEmbedder } from './interview';

export interface RequestFacts {
    elements: Array<{ elementId: string; scope_field_keys: string[]; stored_values: Record<string, unknown>; fields: Array<{ key: string; type: string }> }>;
    answers: Array<{ answerId: string; elementId: string; targetsFieldKeys: string[]; status: string; answer: unknown }>;
}

/** The ids and values a reconcile request carries (its data blocks, before 2.1 fences them). */
export function requestFacts(request: ReconcileRequest): RequestFacts {
    const blocks = new Map(request.data.map((b) => [b.label, b.text]));
    return {
        elements: [...blocks].filter(([l]) => l.startsWith('element.')).map(([, t]) => JSON.parse(t) as RequestFacts['elements'][number]),
        answers: JSON.parse(blocks.get('answers') ?? '[]') as RequestFacts['answers'],
    };
}

/** The request as the SDK would send it: the data fenced in the first user turn. */
export function bodyOf(request: ReconcileRequest): Record<string, unknown> {
    const fence = '0'.repeat(32);
    const user = request.data.map((b) => `<author_data_${fence} label="${b.label}">\n${b.text}\n</author_data_${fence}>`).join('\n');
    return { system: request.template.system, messages: [{ role: 'user', content: user }] };
}

export function scripted(fn: (facts: RequestFacts) => unknown, calls: { n: number } = { n: 0 }): Reconciler {
    return {
        unavailableReason: () => null,
        async reconcile(request) {
            calls.n++;
            return { output: fn(requestFacts(request)), tokensUsed: 1_000, costMicroUsd: 1_000 };
        },
    };
}

export function stubReconciler(calls: { n: number } = { n: 0 }): Reconciler {
    return {
        unavailableReason: () => null,
        async reconcile(request) {
            calls.n++;
            return { output: stubReconcileAnswer(bodyOf(request)), tokensUsed: 1_500, costMicroUsd: 2_000 };
        },
    };
}

export function failing(outcome: ReconcileCallFailure): Reconciler {
    return { unavailableReason: () => null, reconcile: async () => ({ output: null, tokensUsed: 300, failure: { outcome, errorCode: 'TEST' } }) };
}

/**
 * An element interview whose first round is answered (each question with
 * `answerFor(fieldKey)`, or skipped when it returns null), closed and
 * reconciled with `deps`.
 */
export async function seedReconciledRound(
    ctx: WorkspaceRequestContext,
    bookId: string,
    elementId: string,
    deps: EnrichmentDeps = { reconciler: stubReconciler() },
    answerFor: (fieldKey: string) => string | null = (k) => `The ${k.split('_').join(' ')} is plain and true.`,
) {
    // The frontier alone (Phase 4.4): these fixtures count the proposals a round of frontier questions yields.
    const view = await startInterview(ctx, bookId, { scope: 'ELEMENT', elementId, depth: 2, detail: 3, generatorsOff: [...FRONTIER_ONLY] }, { generator: fakeGenerator(), embedder: stubQuestionEmbedder });
    const sessionId = view.session.id;
    const answered: Array<{ questionId: string; fieldKeys: string[] }> = [];
    for (const q of view.round!.questions) {
        const text = answerFor(q.targetsFieldKeys[0]);
        if (text === null) continue;
        // The reply the question's kind takes: a pick, a number, or the words.
        const body = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text };
        await answerQuestion(ctx, bookId, sessionId, q.id, body);
        answered.push({ questionId: q.id, fieldKeys: q.targetsFieldKeys });
    }
    const closed = await closeRoundAndReconcile(ctx, bookId, sessionId, String(view.round!.number), { skipUnanswered: true }, deps);
    return { sessionId, roundNumber: view.round!.number, closed, answered, questions: view.round!.questions };
}
