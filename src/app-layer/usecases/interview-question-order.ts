/**
 * THE TIE-BREAK, the usecase half (Phase 4.4, D30 item 4; the pure half is
 * `src/lib/interview/question-order/`). Asked once per round, after the claim
 * and outside every transaction, by `generateClaimedRound`.
 *
 * The code's value score orders the round (`generators/value.ts`). Among the
 * round's chosen candidates, the FIRST run of near-equal ones (within
 * `ORDER_TIE_BAND`, at most `QUESTION_ORDER_GROUP_MAX`; `tieGroups`) may be
 * REORDERED by one fast call — nothing else moves, no score changes, nothing is
 * added or dropped. The call is a model call like any other: the deployment
 * must be able to make one, an evaluation record this deployment accepts must
 * exist (D11), its worst case must fit the template's per-call budget (ENFORCED)
 * and the session's token budget beside the round, the model-call minute is
 * charged before it is sent (a limited minute skips it, never waits), and 2.1
 * holds it to the monthly ceiling and the kill switch, guard-scans and fences
 * its data, and records it in `AiCallLog`. Its tokens are charged to the
 * session's budget whatever it answers.
 *
 * WHENEVER IT IS NOT MADE, OR ITS ANSWER IS NOT AN EXACT PERMUTATION, THE CODE'S
 * ORDER STANDS, and the round's metrics say so with the reason
 * (`QuestionOrderMetrics`): never a model's order faked, never a round failed
 * for it.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { InterviewSessionRepository, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { RateLimitedError } from '@/lib/errors/types';
import { getTemplate } from '@/lib/bible/templates';
import { nextRoundTokens } from '@/lib/interview/dial-settings';
import { candidateKey, type PlannedTarget, type RoundPlan, type WordedTarget } from '@/lib/interview/plan';
import { tieGroups } from '@/lib/interview/generators/select';
import { pairOfSubject } from '@/lib/interview/subjects';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { questionOrderGate } from '@/lib/interview/question-order/record-gate';
import { QUESTION_ORDER_CALL_COST_BUDGET_MICRO_USD, QUESTION_ORDER_GROUP_MAX, QUESTION_ORDER_PROMPT_VERSION, questionOrderBlocks, type OrderCandidateLine } from '@/lib/interview/question-order/prompt';
import { questionOrderWorstCase, questionOrderWorstTokens } from '@/lib/interview/question-order/cost';
import { defaultQuestionOrderer, type QuestionOrderer } from '@/lib/interview/question-order/model-seam';
import { applyQuestionOrder, validateQuestionOrder } from '@/lib/interview/question-order/validate';
import { logger } from '@/lib/observability/logger';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import { deploymentPackRecordMode } from './interview-packs';
import type { InterviewState } from './interview-state';
import { modelUnavailableReason } from './model-calls';

/** Why the code's order stood. */
export const ORDER_SKIPS = ['NOT_RUN', 'NO_TIE', 'MODEL_UNAVAILABLE', 'NOT_EVALUATED', 'CALL_OVER_BUDGET', 'TOKEN_BUDGET', 'MODEL_RATE_LIMITED', 'ABORTED', 'CALL_FAILED', 'REFUSED'] as const;
export type OrderSkip = (typeof ORDER_SKIPS)[number];

/** What the round's metrics record of its order (codes and numbers, never text). */
export type QuestionOrderMetrics =
    | { status: 'MODEL'; groupSize: number; promptVersion: string; callId: string | null; costMicroUsd: number }
    | { status: 'CODE'; reason: OrderSkip; groupSize?: number; errorCode?: string; callId?: string | null };

export interface QuestionOrderDeps {
    orderer?: (ctx: WorkspaceRequestContext) => QuestionOrderer;
    packRecordMode?: PackRecordMode;
    charge?: (workspaceId: string, calls: number) => void;
    signal?: AbortSignal;
}

/** One chosen candidate of the round, in its rank order. */
type Item = { key: string; value: number; target?: PlannedTarget; worded?: WordedTarget };

/** The round's chosen candidates in rank order (the challenge, always last, is not among them). */
function rankedItems(plan: RoundPlan): Item[] {
    if (!plan.rank) return [];
    const targets = new Map(plan.targets.map((t) => [candidateKey({ elementId: t.elementId, fieldKey: t.fieldKey }), t] as const));
    const worded = new Map((plan.worded ?? []).map((w) => [candidateKey(w), w] as const));
    return [...plan.rank.entries()]
        .sort((a, b) => a[1] - b[1])
        .flatMap(([key]): Item[] => {
            const t = targets.get(key);
            const w = worded.get(key);
            if (t) return [{ key, value: t.value ?? 0, target: t }];
            if (w) return [{ key, value: w.value, worded: w }];
            return [];
        });
}

const GENERATOR_WORDS: Readonly<Record<string, string>> = {
    FRONTIER: 'an empty field',
    SOURCES: "a fact from the author's draft to confirm",
};
const LAYER_WORDS: Readonly<Record<string, string>> = { WHAT: 'a concrete moment', WHY: 'where it comes from', COST: 'what it costs', WHO_KNOWS: 'who knows', BREAKS: 'what breaks it', EDGE_CASES: 'its edge cases' };
const ANGLE_WORDS: Readonly<Record<string, string>> = { WANTS: 'what one wants from the other', COLLIDE: 'where they collide', HIDDEN: 'what one hides from the other' };

/** A candidate as the call is shown it: the subject's kind and name, the field's label, what kind of question. Product words but the names. */
export function orderLine(item: Item, state: Pick<InterviewState, 'elements'>): OrderCandidateLine {
    const c = item.worded ?? item.target!;
    const pair = pairOfSubject(c.elementId);
    if (pair) {
        const name = (id: string) => state.elements.find((e) => e.elementId === id)?.name ?? '';
        return { kind: 'two elements', name: `${name(pair.firstElementId)} and ${name(pair.secondElementId)}`, field: 'Nature of the link', what: `two elements with no link yet: ${ANGLE_WORDS[item.worded?.angle ?? ''] ?? 'their link'}` };
    }
    const subject = state.elements.find((e) => e.elementId === c.elementId);
    const kind = subject?.relation ? 'a link' : subject ? getTemplate(subject.kind).label : 'element';
    const fieldKey = c.fieldKey;
    const field = fieldKey ? (subject?.fields.find((f) => f.key === fieldKey)?.label ?? fieldKey) : null;
    const generator = item.worded?.generator ?? item.target?.generator ?? 'FRONTIER';
    let what = GENERATOR_WORDS[generator] ?? 'an empty field';
    if (generator === 'RELATIONS') what = "a link's empty field";
    if (generator === 'SOURCES' && item.worded?.angle === 'SERIES') what = "a fact from the author's series sources to confirm, for every book in the series";
    if (generator === 'LADDER') what = `a follow-up on an answered field: ${LAYER_WORDS[item.worded?.angle ?? ''] ?? 'more depth'}`;
    if (generator === 'CONTINUITY') {
        const ref = item.worded?.continuityRef ?? '';
        what = ref.startsWith('proposal:') ? 'a contradiction between two things the bible says' : ref.startsWith('thread:') ? 'an open thread' : 'a timeline gap between two dated events';
    }
    const held = generator === 'LADDER' && fieldKey ? (subject?.storedText.get(fieldKey) ?? null) : null;
    return { kind, name: subject?.name ?? '', field, what, ...(held ? { held } : {}) };
}

/** The plan with the round's first run of near-equal candidates reordered, or as it was, and what happened. */
export async function orderRoundTies(
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    claim: { plan: RoundPlan; state: InterviewState },
    deps: QuestionOrderDeps,
): Promise<{ plan: RoundPlan; metrics: QuestionOrderMetrics }> {
    const plan = claim.plan;
    const items = rankedItems(plan);
    const group = tieGroups(items)[0]?.slice(0, QUESTION_ORDER_GROUP_MAX);
    if (!group) return { plan, metrics: { status: 'CODE', reason: 'NO_TIE' } };
    const code = (reason: OrderSkip, extra: Partial<Extract<QuestionOrderMetrics, { status: 'CODE' }>> = {}) => ({ plan, metrics: { status: 'CODE' as const, reason, groupSize: group.length, ...extra } });
    if (modelUnavailableReason()) return code('MODEL_UNAVAILABLE');
    if (!questionOrderGate(deps.packRecordMode ?? deploymentPackRecordMode()).mounted) return code('NOT_EVALUATED');
    if (deps.signal?.aborted) return code('ABORTED');
    const tied = group.map((i) => items[i]);
    const blocks = questionOrderBlocks(tied.map((it) => orderLine(it, claim.state)));
    // RULE 9, ENFORCED: a call whose worst case passes its per-call budget is not sent.
    if (questionOrderWorstCase(blocks) > QUESTION_ORDER_CALL_COST_BUDGET_MICRO_USD) return code('CALL_OVER_BUDGET');
    // THE SESSION'S BUDGET, before anything is sent (2.H): the round must still fit beside the call's worst case. The
    // spend is read NOW, not off the claim's row: the round's compaction summary (made since the claim) is charged by then.
    const reserve = nextRoundTokens(session.personaKeys.length, plan.targets.length > 0 || plan.challenge ? Math.max(1, session.personaKeys.length) : 0);
    const spent = (await runInWorkspaceContext(ctx, (db) => InterviewSessionRepository.find(db, ctx.workspaceId, session.bookId, session.id)))?.tokensUsed ?? session.tokensUsed;
    if (spent + reserve + questionOrderWorstTokens(blocks) > session.tokenBudget) return code('TOKEN_BUDGET');
    try {
        (deps.charge ?? chargeModelCalls)(ctx.workspaceId, 1);
    } catch (err) {
        if (err instanceof RateLimitedError) return code('MODEL_RATE_LIMITED');
        throw err;
    }
    try {
        const result = await (deps.orderer ?? ((c: WorkspaceRequestContext) => defaultQuestionOrderer(c)))(ctx).extract({ data: blocks, bookId: session.bookId }, deps.signal);
        if (result.tokensUsed > 0) await runInWorkspaceContext(ctx, (db) => InterviewSessionRepository.addTokens(db, ctx.workspaceId, session.id, result.tokensUsed));
        const callId = result.callIds[0] ?? null;
        if (!result.ok) return code('CALL_FAILED', { errorCode: result.failure, callId });
        const v = validateQuestionOrder(result.output, tied.length);
        if (!v.ok) return code('REFUSED', { errorCode: v.reason, callId });
        const reordered = [...items];
        applyQuestionOrder(tied, v.order).forEach((it, j) => (reordered[group[j]] = it));
        const rank = new Map(reordered.map((it, i) => [it.key, i] as const));
        return { plan: { ...plan, rank }, metrics: { status: 'MODEL', groupSize: tied.length, promptVersion: QUESTION_ORDER_PROMPT_VERSION, callId, costMicroUsd: result.costMicroUsd } };
    } catch (err) {
        logger.warn('interview.question_order_failed', { component: 'interview', sessionId: session.id, error: err instanceof Error ? err.name : 'unknown' });
        return code('CALL_FAILED');
    }
}
