/**
 * LONG-SESSION COMPACTION, the usecase half (Phase 4.3, D29; the pure half and
 * its header are `src/lib/interview/compaction.ts`). Asked once per round,
 * after the claim and outside every transaction, by `generateClaimedRound`:
 *
 *   1. OFF unless the request turns it on (`InterviewDeps.compaction`; the
 *      brake `COMPACTION_ON_BY_DEFAULT` is false until 4.4), and only past the
 *      threshold with at least two rounds answered (`compactionSkip`).
 *   2. A summary already stored for exactly these rounds is reused: it is never
 *      generated again (the same rounds, the same summary).
 *   3. Otherwise ONE fast call, a model call like any other: the deployment
 *      must be able to make one, an evaluation record this deployment accepts
 *      must exist (D11), the model-call minute is charged (a limited minute
 *      skips, never waits a round), and 2.1 holds the call to the monthly
 *      ceiling and the kill switch, guard-scans and fences its data, and records
 *      it in `AiCallLog`. The session's token budget must take the call's worst
 *      case beside the round it serves BEFORE it is sent (else no compaction),
 *      and its tokens are charged to that budget. The
 *      summary is validated (`validateRoundsSummary`) and stored once,
 *      sanitised and encrypted.
 *   4. The state block is built BY CODE from the session's own record: the
 *      scope, the pinned packs, every earlier answer verbatim, the bible changes
 *      the author accepted verbatim, the reconcile refusals by code.
 *
 * ANY failure leaves the round uncompacted (every round verbatim, as before):
 * compaction only ever saves context, so it never fails a round.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { EnrichmentProposalRepository, ReconcileRunRepository } from '@/app-layer/repositories/enrichment.repository';
import { InterviewCompactionRepository } from '@/app-layer/repositories/interrogation.repository';
import { InterviewSessionRepository, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { RateLimitedError } from '@/lib/errors/types';
import { buildSessionState, compactedThrough, compactionSkip, DEFAULT_COMPACTION, summaryRequestBlocks, type AcceptedChange, type CompactedSession, type CompactionSettings, type RoundAnswer } from '@/lib/interview/compaction';
import { compactionGate } from '@/lib/interview/compaction-gate';
import { COMPACTION_PROMPT_VERSION, sanitiseSummaryForStorage, validateRoundsSummary } from '@/lib/interview/compaction-prompt';
import { compactionCallWorstTokens, defaultRoundsSummarizer, type RoundsSummarizer } from '@/lib/interview/compaction-seam';
import { nextRoundTokens } from '@/lib/interview/dial-settings';
import { parsePackPins } from '@/lib/interview/pack-mount';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { logger } from '@/lib/observability/logger';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import { deploymentPackRecordMode } from './interview-packs';
import { answerText, type InterviewState } from './interview-state';
import { subjectIdOf } from '@/lib/interview/subjects';
import { modelUnavailableReason } from './model-calls';

export interface CompactionDeps {
    /** Turns compaction on (or off) for this request; omitted: `DEFAULT_COMPACTION` (off until 4.4). */
    compaction?: CompactionSettings;
    summarizer?: (ctx: WorkspaceRequestContext) => RoundsSummarizer;
    packRecordMode?: PackRecordMode;
    charge?: (workspaceId: string, calls: number) => void;
    /** The round's signal (a streamed request's client gone): no summary call is started, and one in flight is cut. */
    signal?: AbortSignal;
}

/** Proposals and runs a state block reads at most. */
const PROPOSALS_READ_MAX = 500;
const RUNS_READ_MAX = 50;

/** The session's answers with the round each question was asked in (latest revision each), as the prompt carries them. */
export function roundAnswersOf(state: Pick<InterviewState, 'questions' | 'latest' | 'rounds'>): RoundAnswer[] {
    const roundOf = new Map(state.rounds.map((r) => [r.id, r.number] as const));
    return state.questions.flatMap((q) => {
        const a = state.latest.get(q.id);
        const round = roundOf.get(q.roundId);
        if (!a || round === undefined) return [];
        return [{ answerId: a.id, elementId: subjectIdOf(q), targetsFieldKeys: q.targetsFieldKeys, questionKind: q.kind, question: q.text, status: a.status, answer: answerText(a), roundNumber: round }];
    });
}

/** The compacted session for this round, or undefined (off, below threshold, or any failure). */
export async function compactedSessionFor(
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    claim: { state: InterviewState; roundNumber: number },
    deps: CompactionDeps,
): Promise<CompactedSession | undefined> {
    const settings = deps.compaction ?? DEFAULT_COMPACTION;
    const answers = roundAnswersOf(claim.state).filter((a) => a.roundNumber < claim.roundNumber);
    const skip = compactionSkip(settings, answers);
    if (skip) return undefined;
    const through = compactedThrough(answers);
    try {
        let summary = (await runInWorkspaceContext(ctx, (db) => InterviewCompactionRepository.findThrough(db, ctx.workspaceId, session.id, through)))?.summary ?? null;
        if (summary === null) {
            if (modelUnavailableReason()) return undefined;
            if (!compactionGate(deps.packRecordMode ?? deploymentPackRecordMode()).mounted) return undefined;
            if (deps.signal?.aborted) return undefined;
            const blocks = summaryRequestBlocks(answers, through);
            // THE SESSION'S BUDGET, before anything is sent (2.H): the round this compaction serves must still fit beside
            // the summary call's worst case, or the round goes uncompacted.
            if (session.tokensUsed + nextRoundTokens(session.personaKeys.length) + compactionCallWorstTokens(blocks) > session.tokenBudget) return undefined;
            try {
                (deps.charge ?? chargeModelCalls)(ctx.workspaceId, 1);
            } catch (err) {
                if (err instanceof RateLimitedError) return undefined;
                throw err;
            }
            const result = await (deps.summarizer ?? ((c: WorkspaceRequestContext) => defaultRoundsSummarizer(c)))(ctx).extract({ data: blocks, bookId: session.bookId }, deps.signal);
            if (result.tokensUsed > 0) await runInWorkspaceContext(ctx, (db) => InterviewSessionRepository.addTokens(db, ctx.workspaceId, session.id, result.tokensUsed));
            if (!result.ok) return undefined;
            const v = validateRoundsSummary(result.output, { text: blocks.map((b) => b.text).join('\n'), answers: answers.map((a) => a.answer ?? '').filter((t) => t !== '') });
            if (!v.ok) return undefined;
            const stored = sanitiseSummaryForStorage(v.summary);
            await runInWorkspaceContext(ctx, async (db) => {
                const written = await InterviewCompactionRepository.create(db, ctx.workspaceId, { sessionId: session.id, throughRound: through, summary: stored, promptVersion: COMPACTION_PROMPT_VERSION, tokensUsed: result.tokensUsed, costMicroUsd: result.costMicroUsd });
                // AUDIT LAST.
                if (written) await logEvent(ctx, { action: 'INTERVIEW_COMPACTED', entityType: 'InterviewSession', entityId: session.id, details: { throughRound: through, answerCount: answers.length } }, { db });
            });
            summary = stored;
        }
        const state = await runInWorkspaceContext(ctx, async (db) => {
            const proposals = await EnrichmentProposalRepository.listForSession(db, ctx.workspaceId, session.id, PROPOSALS_READ_MAX);
            const runs = await ReconcileRunRepository.listForSession(db, ctx.workspaceId, session.id, RUNS_READ_MAX);
            const names = new Map(claim.state.elements.map((e) => [e.elementId, e.name] as const));
            const accepted: AcceptedChange[] = proposals
                .filter((p) => p.status === 'ACCEPTED')
                .map((p) => ({
                    subject: p.kind === 'NEW_ELEMENT' ? (p.newName ?? '') : (names.get(p.relationId ?? p.elementId ?? '') ?? (p.elementId ?? '')),
                    fieldKey: p.fieldKey,
                    operation: p.kind === 'FIELD' || p.kind === 'RELATION_FIELD' ? (p.operation ?? p.kind) : p.kind,
                    value: p.proposedValue ?? p.newSummary ?? '',
                }));
            const refusals: Record<string, number> = {};
            for (const r of runs) {
                const refused = (r.metrics as { refused?: Record<string, unknown> } | null)?.refused ?? {};
                for (const [code, n] of Object.entries(refused)) if (typeof n === 'number') refusals[code] = (refusals[code] ?? 0) + n;
            }
            return buildSessionState({
                scope: claim.state.elements.map((e) => `${e.kind}: ${e.name}`),
                packs: (parsePackPins(session.packPins) ?? []).map((p) => ({ name: p.name, version: p.version })),
                answers,
                throughRound: through,
                accepted,
                refusals,
            });
        });
        return { state, summary, throughRound: through, recentAnswerIds: new Set(answers.filter((a) => a.roundNumber > through).map((a) => a.answerId)) };
    } catch (err) {
        logger.warn('interview.compaction_failed', { component: 'interview', sessionId: session.id, error: err instanceof Error ? err.name : 'unknown' });
        return undefined;
    }
}
