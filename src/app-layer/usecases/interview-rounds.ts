/**
 * Running a round (Phase 2.2): claim it, generate it, persist it — or stop
 * the session and say why. Shared by `startInterview` and `nextRound`
 * (`interviews.ts`); not a public usecase module.
 *
 * THE ROUND, in three transactions with the model call outside them:
 *
 *   1. CLAIM (under the session's advisory lock): load the state, decide
 *      whether the session stops (`decideStop`, then the frontier's own
 *      stops); if not, and the generator is wired, write the round as
 *      GENERATING with its plan. A session holds at most one GENERATING or
 *      OPEN round, so two tabs cannot generate one round twice. If the
 *      generator is NOT wired the claim refuses 503 `MODEL_NOT_WIRED` before
 *      it writes anything.
 *   2. GENERATE (no transaction): `produceRound` — the model words, code
 *      validates, deduplicates (with the vector store's neighbours, read in a
 *      short transaction of their own), fills gaps from the packs, orders.
 *   3. PERSIST (under the lock again): if the round is still the session's
 *      GENERATING round, write its questions (sanitised once more on the way
 *      in) and open it, then file their vectors in a transaction of their own
 *      (a vector-store failure degrades later deduplication, never the
 *      round); a round that produced no question is
 *      FAILED and the session PAUSED with the reason (`PROVIDER_FAILURE` when
 *      every call failed, else `NO_ACCEPTABLE_QUESTION`), resumable by the
 *      next round.
 *
 * A session whose plan is empty ends at once with FRONTIER_EMPTY or
 * NOTHING_AT_DEPTH (and `stopDetail` naming which fields wait on which); one
 * whose rounds are spent ends with ROUND_BUDGET. When both hold, the
 * frontier's reason is the one given: nothing would be left to ask anyway.
 */
import { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { InterviewRoundRepository, InterviewSessionRepository, QuestionRepository, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, ServiceUnavailableError } from '@/lib/errors/types';
import { getTemplate } from '@/lib/bible/templates';
import { TOKENS_PER_GENERATION_CALL } from '@/lib/interview/dials';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { isVerbatimQuote } from '@/lib/interview/candidates';
import { dedupeTokens, exactKey, questionDedupeKey } from '@/lib/interview/dedupe';
import type { FrontierResult } from '@/lib/interview/frontier';
import type { QuestionGenerator } from '@/lib/interview/generator';
import { defaultQuestionGenerator, modelBudgetSignals } from '@/lib/interview/model-seam';
import { getPacks, type PackRegistry } from '@/lib/interview/packs';
import { planRound, type RoundPlan } from '@/lib/interview/plan';
import { QUESTION_PROMPT_VERSION } from '@/lib/interview/prompt';
import { produceRound, type PlannedQuestion, type RoundOutput } from '@/lib/interview/round';
import { logger } from '@/lib/observability/logger';
import type { VectorRecord } from '@/app-layer/repositories/vector.repository';
import { decideStop } from '@/lib/interview/stop';
import { encodeJson, sanitiseQuestionForStorage } from '@/lib/interview/storage';
import { STATUS_AFTER_STOP, type StopReason } from '@/lib/interview/vocabulary';
import { challengeableOf, frontierOf, frontierStop, loadInterviewState, nextRoundNumber, stopDetailFor, storedTextOf, type InterviewState } from './interview-state';
import { defaultQuestionEmbedder, findQuestionNeighbours, questionRecord, upsertQuestionVectors, type QuestionEmbedder } from './question-embeddings';

/** What a usecase may be handed instead of the deployment's own (tests; the evaluation). */
export interface InterviewDeps {
    generator?: QuestionGenerator;
    /** `null`: no embedder (deduplication stays lexical). Omitted: the deployment's. */
    embedder?: QuestionEmbedder | null;
    packs?: PackRegistry;
}

/** A GENERATING round older than this is a claim whose process died: the next request fails it and goes on. */
export const STALE_CLAIM_MS = 5 * 60_000;

export const MODEL_NOT_WIRED = { reason: 'MODEL_NOT_WIRED' } as const;

export function generatorOf(deps: InterviewDeps): QuestionGenerator {
    return deps.generator ?? defaultQuestionGenerator();
}

/** Refuse, before anything is written, a request that needs the model when none is wired. */
export function assertGeneratorWired(generator: QuestionGenerator): void {
    if (!generator.wired) throw new ServiceUnavailableError('Questions cannot be generated yet: the model is not wired.', MODEL_NOT_WIRED);
}

/** End a session with its reason, in the caller's transaction. */
export async function endSession(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, reason: StopReason, detail: Prisma.InputJsonValue): Promise<void> {
    const status = STATUS_AFTER_STOP[reason];
    await InterviewSessionRepository.update(db, ctx.workspaceId, session.id, {
        status,
        stopReason: reason,
        stopDetail: detail,
        endedAt: status === 'COMPLETED' || status === 'STOPPED' ? new Date() : null,
    });
    await logEvent(
        ctx,
        { action: 'INTERVIEW_ENDED', entityType: 'InterviewSession', entityId: session.id, details: { bookId: session.bookId, reason, status, roundsRun: session.roundsRun } },
        { db },
    );
}

export type ClaimOutcome =
    | { kind: 'stopped'; reason: StopReason }
    | { kind: 'claimed'; roundId: string; roundNumber: number; plan: RoundPlan; state: InterviewState };

function planOf(state: InterviewState, session: SessionRow): { frontier: FrontierResult; plan: RoundPlan } {
    const frontier = frontierOf(state, session.depth);
    const plan = planRound({
        frontier: frontier.frontier,
        challengeable: challengeableOf(frontier, session.depth),
        challenged: state.challenged,
        challengesPlanned: state.challengesPlanned,
        depth: session.depth,
        detail: session.detail,
        personaKeys: session.personaKeys,
        roundNumber: nextRoundNumber(state),
    });
    return { frontier, plan };
}

/** Would the session stop now, and why (the precedence below)? Pure over a loaded state. */
export function stopNow(
    session: SessionRow,
    state: InterviewState,
    signals: { killSwitch: boolean; workspaceCeilingReached: boolean } = { killSwitch: false, workspaceCeilingReached: false },
): { reason: StopReason; detail: Prisma.InputJsonValue } | null {
    const { frontier, plan } = planOf(state, session);
    const fromFrontier = frontierStop(frontier, plan);
    const budget = decideStop({
        ...signals,
        tokenBudget: session.tokenBudget,
        tokensUsed: session.tokensUsed,
        nextRoundTokens: Math.max(1, session.personaKeys.length) * TOKENS_PER_GENERATION_CALL,
        authorStopped: false,
        roundBudget: session.roundBudget,
        roundsRun: session.roundsRun,
    });
    // The precedence (implementation note, "Stop precedence"): 2.1's kill
    // switch and spend ceiling first; then the frontier's own reasons; then
    // the session's token and round budgets. A session with nothing left to
    // ask COMPLETES saying so, even when a budget is spent too: a spent token
    // budget would only PAUSE it, and it could never resume (its tokens only
    // grow), so it would stay paused with nothing left to ask.
    if (budget === 'KILL_SWITCH' || budget === 'WORKSPACE_CEILING') return { reason: budget, detail: stopDetailFor(budget, frontier) };
    if (fromFrontier) return { reason: fromFrontier, detail: stopDetailFor(fromFrontier, frontier, { scopeElements: state.elements.length }) };
    if (budget) return { reason: budget, detail: stopDetailFor(budget, frontier) };
    return null;
}

/** Plan the session's next round and claim it, or end the session. Runs under the session's lock. */
export async function claimRound(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, generator: QuestionGenerator): Promise<ClaimOutcome> {
    const state = await loadInterviewState(db, ctx, session);
    for (const r of state.rounds) {
        if (r.status === 'OPEN') throw new ConflictError('Close the open round first.', { reason: 'ROUND_OPEN', roundNumber: r.number });
        if (r.status === 'GENERATING') {
            if (Date.now() - r.startedAt.getTime() < STALE_CLAIM_MS) throw new ConflictError('A round is being generated.', { reason: 'ROUND_GENERATING', roundNumber: r.number });
            await InterviewRoundRepository.update(db, ctx.workspaceId, r.id, { status: 'FAILED' });
        }
    }
    const stop = stopNow(session, state, await modelBudgetSignals(ctx.workspaceId));
    if (stop) {
        await endSession(db, ctx, session, stop.reason, stop.detail);
        return { kind: 'stopped', reason: stop.reason };
    }
    assertGeneratorWired(generator);
    const { frontier, plan } = planOf(state, session);
    const roundNumber = nextRoundNumber(state);
    const round = await InterviewRoundRepository.create(db, ctx.workspaceId, {
        sessionId: session.id,
        number: roundNumber,
        promptVersion: QUESTION_PROMPT_VERSION,
        plan: {
            cap: plan.cap,
            targets: plan.targets.map((t) => ({ elementId: t.elementId, fieldKey: t.fieldKey, level: t.level, personaKey: t.personaKey })),
            carried: plan.carried.map((t) => ({ elementId: t.elementId, fieldKey: t.fieldKey, level: t.level })),
            challenge: plan.challenge ? { ...plan.challenge } : null,
            frontierSize: frontier.frontier.length,
            blocked: frontier.blocked.length,
        },
    });
    if (session.status !== 'ACTIVE') {
        // Resuming a paused session: it is active again, and its stop is history.
        await InterviewSessionRepository.update(db, ctx.workspaceId, session.id, { status: 'ACTIVE', stopReason: null, stopDetail: Prisma.DbNull, endedAt: null });
    }
    return { kind: 'claimed', roundId: round.id, roundNumber, plan, state };
}

/** The questions whose ANSWERED answers settled `q`'s prerequisites in this session (derived; display and audit). */
function dependsOnQuestionIds(q: PlannedQuestion, state: InterviewState): string[] {
    const element = state.elements.find((e) => e.elementId === q.elementId);
    if (!element) return [];
    const template = getTemplate(element.kind);
    const prereqs = new Set(q.targetsFieldKeys.flatMap((k) => template.fields.find((f) => f.key === k)?.dependsOn ?? []));
    return state.questions
        .filter((asked) => asked.elementId === q.elementId && asked.targetsFieldKeys.some((k) => prereqs.has(k)) && state.latest.get(asked.id)?.status === 'ANSWERED')
        .map((asked) => asked.id);
}

/** Generate the claimed round and persist it (or fail it). Returns once the round is OPEN or FAILED. */
export async function generateClaimedRound(
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    claim: Extract<ClaimOutcome, { kind: 'claimed' }>,
    deps: InterviewDeps,
): Promise<void> {
    const generator = generatorOf(deps);
    const embedder = deps.embedder === undefined ? defaultQuestionEmbedder() : deps.embedder;
    const packs = deps.packs ?? getPacks();
    const { state, plan } = claim;
    const known = new Set(state.asked.map((q) => q.id));

    let output: RoundOutput;
    try {
        output = await produceRound(
            {
                workspaceId: ctx.workspaceId,
                dials: { depth: session.depth, detail: session.detail },
                offerRecommended: session.offerRecommended,
                preferChoice: session.preferChoice,
                personaKeys: session.personaKeys,
                plan,
                elements: state.elements,
                related: state.related,
                sessionAnswers: state.promptAnswers,
                asked: state.asked,
                packs,
            },
            {
                generator,
                embed: embedder ? (texts) => embedder.embed(texts) : undefined,
                findNeighbours: embedder ? (vectors) => neighboursOrNone(ctx, session.bookId, embedder.revision, vectors, known) : undefined,
                findExactRepeats: (probes) => exactRepeatsOrNone(ctx, session.bookId, probes),
            },
        );
    } catch (err) {
        await runInWorkspaceContext(ctx, async (db) => {
            await InterviewSessionRepository.lock(db, session.id);
            await InterviewRoundRepository.update(db, ctx.workspaceId, claim.roundId, { status: 'FAILED' });
            const current = await InterviewSessionRepository.find(db, ctx.workspaceId, session.bookId, session.id);
            if (current?.status === 'ACTIVE') await endSession(db, ctx, current, 'PROVIDER_FAILURE', { roundNumber: claim.roundNumber });
        });
        throw err;
    }

    const records = await runInWorkspaceContext(ctx, async (db): Promise<VectorRecord[]> => {
        await InterviewSessionRepository.lock(db, session.id);
        const current = await InterviewSessionRepository.find(db, ctx.workspaceId, session.bookId, session.id);
        // What the calls cost is charged whatever becomes of the round (rule 9; the token budget reads it).
        if (current) await InterviewSessionRepository.addTokens(db, ctx.workspaceId, session.id, output.metrics.tokensUsed);
        const round = await InterviewRoundRepository.find(db, ctx.workspaceId, session.id, claim.roundId);
        // Stopped while it generated: the author's stop stands, and the questions are not asked.
        if (!current || current.status !== 'ACTIVE' || round?.status !== 'GENERATING') return [];

        // The book may have moved while the model worded the round (no lock is
        // held then): a field the author filled in the meantime is answered,
        // and is not asked (rule 5); an element deleted in the meantime is not
        // asked about; a challenge whose quote is no longer in the stored value
        // is not asked. Read again here, under the lock, and drop those.
        const askable = await stillAskable(db, ctx, session.bookId, output.questions);
        const questions = askable.map((q, i) => ({ ...q, position: i + 1 }));
        const metrics = { ...output.metrics, staleAtPersist: output.questions.length - questions.length } as unknown as Prisma.InputJsonValue;

        if (questions.length === 0) {
            await InterviewRoundRepository.update(db, ctx.workspaceId, claim.roundId, { status: 'FAILED', metrics });
            if (output.questions.length > 0) {
                // Everything it worded was overtaken by the book: say what the book now says.
                const after = await InterviewSessionRepository.find(db, ctx.workspaceId, session.bookId, session.id);
                const stop = after ? stopNow(after, await loadInterviewState(db, ctx, after)) : null;
                await endSession(db, ctx, after ?? current, stop?.reason ?? 'NO_ACCEPTABLE_QUESTION', stop?.detail ?? { roundNumber: claim.roundNumber, staleAtPersist: output.questions.length });
                return [];
            }
            const allFailed = output.metrics.generationCalls > 0 && output.metrics.generationFailures === output.metrics.generationCalls;
            await endSession(db, ctx, current, allFailed ? 'PROVIDER_FAILURE' : 'NO_ACCEPTABLE_QUESTION', { roundNumber: claim.roundNumber, noQuestion: output.metrics.noQuestion.length });
            return [];
        }

        const textCtx = { elementNames: new Map(state.elements.map((e) => [e.elementId, e.name])) };
        const records: VectorRecord[] = [];
        for (const planned of questions) {
            const q = sanitiseQuestionForStorage(planned);
            const created = await QuestionRepository.create(db, ctx.workspaceId, {
                bookId: session.bookId,
                sessionId: session.id,
                roundId: claim.roundId,
                position: planned.position,
                elementId: q.elementId,
                targetsFieldKeys: q.targetsFieldKeys,
                mode: q.mode,
                origin: planned.origin,
                personaKey: q.personaKey,
                kind: q.kind,
                text: q.text,
                options: encodeJson(q.options),
                scaleLabels: encodeJson(q.scaleLabels),
                recommendedAnswer: encodeJson(q.recommendedAnswer),
                recommendationBasis: q.recommendationBasis ?? Prisma.DbNull,
                rationale: q.rationale,
                challengeQuote: q.challengeQuote,
                dependsOnQuestionIds: dependsOnQuestionIds(planned, state),
                dedupeKey: questionDedupeKey(dedupeTokens(q, textCtx)),
            });
            const vector = output.vectors.get(askable[planned.position - 1].position);
            if (vector && embedder) records.push(questionRecord(created.id, session.bookId, created.text, vector, embedder.revision));
        }
        await InterviewRoundRepository.update(db, ctx.workspaceId, claim.roundId, { status: 'OPEN', openedAt: new Date(), metrics });
        await logEvent(
            ctx,
            {
                action: 'INTERVIEW_ROUND_OPENED',
                entityType: 'InterviewRound',
                entityId: claim.roundId,
                details: {
                    sessionId: session.id,
                    roundNumber: claim.roundNumber,
                    questionCount: questions.length,
                    packFallbacks: output.metrics.packFallbacks,
                    promptVersion: QUESTION_PROMPT_VERSION,
                },
            },
            { db },
        );
        return records;
    });

    // The vectors are filed after the questions commit, in a transaction of
    // their own: a vector-store failure degrades deduplication for later
    // rounds (the lexical signals and the dedupe key still hold) and never
    // undoes a round the author can already see. A question deleted in
    // between is refused by the store's source guard, so nothing outlives it.
    if (records.length > 0) {
        try {
            await runInWorkspaceContext(ctx, (db) => upsertQuestionVectors(db, ctx, records));
        } catch (err) {
            logger.warn('interview.question_vectors_not_stored', { component: 'interview', sessionId: session.id, count: records.length, error: err instanceof Error ? err.name : 'unknown' });
        }
    }
}

/**
 * The produced questions the book still lets this round ask, in order: the
 * element still exists, a FRONTIER question's fields are all still empty (rule
 * 5), and a CHALLENGE's quote is still a verbatim run of its stored value.
 */
async function stillAskable(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, questions: readonly PlannedQuestion[]): Promise<PlannedQuestion[]> {
    const ids = [...new Set(questions.map((q) => q.elementId))];
    const live = new Set((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, ids)).map((e) => e.id));
    const stored = await storedTextOf(db, ctx, [...live]);
    return questions.filter((q) => {
        if (!live.has(q.elementId)) return false;
        const values = stored.get(q.elementId) ?? new Map<string, string>();
        if (q.mode === 'CHALLENGE') {
            const value = values.get(q.targetsFieldKeys[0]);
            return value !== undefined && q.challengeQuote !== null && isVerbatimQuote(q.challengeQuote, value);
        }
        return q.targetsFieldKeys.every((k) => !values.has(k));
    });
}

/** The book's exact repeats among these probes, or none when the read fails (deduplication keeps its other signals). */
async function exactRepeatsOrNone(ctx: WorkspaceRequestContext, bookId: string, probes: ReadonlyArray<{ elementId: string; dedupeKey: string }>): Promise<Set<string>> {
    try {
        const rows = await runInWorkspaceContext(ctx, (db) => QuestionRepository.findExactRepeats(db, ctx.workspaceId, bookId, probes));
        return new Set(rows.map((r) => exactKey(r.elementId, r.dedupeKey)));
    } catch (err) {
        logger.warn('interview.question_exact_repeats_unavailable', { component: 'interview', error: err instanceof Error ? err.name : 'unknown' });
        return new Set();
    }
}

/** The store's neighbours, or none when the store fails (deduplication then keeps its lexical signals). */
async function neighboursOrNone(...args: Parameters<typeof findQuestionNeighbours>): ReturnType<typeof findQuestionNeighbours> {
    try {
        return await findQuestionNeighbours(...args);
    } catch (err) {
        logger.warn('interview.question_neighbours_unavailable', { component: 'interview', error: err instanceof Error ? err.name : 'unknown' });
        return { neighbours: new Map(), neighbourTargets: new Map() };
    }
}
