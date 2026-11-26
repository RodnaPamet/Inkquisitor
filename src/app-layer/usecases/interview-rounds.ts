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
 *      OPEN round, so two tabs cannot generate one round twice. If no model
 *      call can be made under the deployment's configuration (no key, ambient
 *      SDK headers, no declared retention mode) the claim refuses 503
 *      `AI_UNAVAILABLE`, naming 2.1's reason, before it writes anything.
 *   2. GENERATE (no transaction): `produceRound` — the model words, code
 *      validates, deduplicates (with the vector store's neighbours, read in a
 *      short transaction of their own), fills gaps from the packs, orders.
 *   3. PERSIST (under the lock again): if the round is still the session's
 *      GENERATING round, write its questions (sanitised once more on the way
 *      in) and open it, then file their vectors in a transaction of their own
 *      (a vector-store failure degrades later deduplication, never the
 *      round); a round that produced no question is
 *      FAILED and the session PAUSED with the reason (`GUARD_REFUSED` when the
 *      guard refused every call, `PROVIDER_FAILURE` when every call failed
 *      and one at least for the provider's sake, else `NO_ACCEPTABLE_QUESTION`:
 *      `emptyRoundStopReason`), resumable by the next round. A call
 *      that must stop the whole session (2.1's kill switch, the spend
 *      ceiling: `GenerationStop`, `model-seam.ts`) abandons the round — FAILED,
 *      its tokens charged — and pauses the session with that reason.
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
import { ConflictError } from '@/lib/errors/types';
import { AiUnavailableError, type AiUnavailableReason } from '@/lib/ai/errors';
import { isVerbatimQuote } from '@/lib/interview/candidates';
import { dedupeTokens, exactKey, questionDedupeKey } from '@/lib/interview/dedupe';
import type { FrontierResult } from '@/lib/interview/frontier';
import { GenerationStop, type QuestionGenerator } from '@/lib/interview/generator';
import { defaultQuestionGenerator, modelBudgetSignals } from '@/lib/interview/model-seam';
import { getPacks, type PackRegistry } from '@/lib/interview/packs';
import { PacksNotMountableError, packNamesFor, parsePackPins, pinMismatch, type MountVerdict, type PackRecordMode } from '@/lib/interview/pack-mount';
import { nextRoundGenerationCalls, nextRoundTokens } from '@/lib/interview/dial-settings';
import { planRound, type RoundPlan } from '@/lib/interview/plan';
import { QUESTION_PROMPT_VERSION } from '@/lib/interview/prompt';
import { produceRound, TOKENS_PER_CALL_REPORT_MAX, type PlannedQuestion, type RoundObserver, type RoundOutput } from '@/lib/interview/round';
import type { InterviewStreamEvent, PlannedField } from '@/lib/interview/stream-events';
import { logger } from '@/lib/observability/logger';
import type { VectorRecord } from '@/app-layer/repositories/vector.repository';
import { decideStop } from '@/lib/interview/stop';
import { recordRoundRepetition } from '@/lib/interview/repetition';
import { cosineThresholdsFor } from '@/lib/interview/dedupe-thresholds';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import { env } from '@/env';
import { encodeJson, sanitiseQuestionForStorage } from '@/lib/interview/storage';
import { STATUS_AFTER_STOP, type PersonaKey, type StopReason } from '@/lib/interview/vocabulary';
import { PENDING_SUBJECT_ID, subjectIdOf } from '@/lib/interview/subjects';
import { assembleSourceContext, EMPTY_SOURCE_CONTEXT, type SourceContext } from './source-retrieval';
import { challengeableOf, frontierOf, frontierStop, loadInterviewState, nextRoundNumber, stopDetailFor, type InterviewState } from './interview-state';
import { defaultQuestionEmbedder, findQuestionNeighbours, questionRecord, upsertQuestionVectors, type QuestionEmbedder } from './question-embeddings';

/**
 * Where a streamed request (Phase 2.4) is told what happens: the events of
 * `src/lib/interview/stream-events.ts`, and `ready()` once the work is under
 * way (the round claimed, or a new session written), after which a failure is
 * an event rather than the route's JSON error (`stream-response.ts`).
 */
export interface InterviewStream {
    emit(event: InterviewStreamEvent): void;
    ready(): void;
}

/** What a usecase may be handed instead of the deployment's own (tests; the evaluation), and a stream's sink. */
export interface InterviewDeps {
    generator?: QuestionGenerator;
    /** `null`: no embedder (deduplication stays lexical). Omitted: the deployment's. */
    embedder?: QuestionEmbedder | null;
    packs?: PackRegistry;
    /** A streamed request's sink (Phase 2.4); absent for the JSON routes. */
    stream?: InterviewStream;
    /**
     * Aborted when the client of a streamed request goes away (Phase 2.4): the
     * model call in flight is cut, no further call is made, and the claimed
     * round is abandoned (FAILED, its tokens charged; the session stays
     * resumable). Nothing of the round is written.
     */
    signal?: AbortSignal;
    /** Which evaluation records mount a pack (tests); omitted: the deployment's (D11). */
    packRecordMode?: PackRecordMode;
}

/** The packs a request runs on and the mount gate's verdict on each. */
export interface PackContext {
    registry: PackRegistry;
    /** The verdicts on the named packs (each computed once per process). */
    mounts(names: readonly string[]): Promise<ReadonlyMap<string, MountVerdict>>;
}

/** Tell the stream, if any, that a round was claimed: which fields it targets (keys only), and that the work is under way. */
export function announceClaim(deps: InterviewDeps, claim: ClaimOutcome): void {
    if (!deps.stream || claim.kind !== 'claimed') return;
    const targets: PlannedField[] = claim.plan.targets.map((t) => ({ elementId: t.elementId, fieldKey: t.fieldKey }));
    if (claim.plan.challenge) targets.push({ elementId: claim.plan.challenge.elementId, fieldKey: claim.plan.challenge.fieldKey });
    deps.stream.emit({ type: 'planned', roundNumber: claim.roundNumber, targets });
    deps.stream.ready();
}

/** The round's observer for a stream: drafts as each call's candidates pass validation. Never changes the round. */
function streamObserver(stream: InterviewStream | undefined): RoundObserver | undefined {
    if (!stream) return undefined;
    let next = 0;
    return {
        callStarted: ({ index, total }) => stream.emit({ type: 'thinking', call: index, calls: total }),
        candidatesValidated: (candidates, { reviewRequired }) => {
            for (const c of candidates) {
                next += 1;
                stream.emit({
                    type: 'draft',
                    draftId: `draft-${next}`,
                    question: {
                        elementId: c.elementId,
                        targetsFieldKeys: [...c.targetsFieldKeys],
                        mode: c.mode,
                        kind: c.kind,
                        text: c.text,
                        options: c.options ? [...c.options] : null,
                        scaleLabels: c.scaleLabels ? { ...c.scaleLabels } : null,
                        personaKey: c.personaKey,
                        reviewRequired,
                    },
                });
            }
        },
        checking: () => stream.emit({ type: 'checking' }),
    };
}

/** A GENERATING round older than this is a claim whose process died: the next request fails it and goes on. */
export const STALE_CLAIM_MS = 5 * 60_000;

/** The context's generator: the one handed in (tests, the evaluation), else the deployment's over 2.1. */
export function generatorOf(ctx: WorkspaceRequestContext, deps: InterviewDeps): QuestionGenerator {
    return deps.generator ?? defaultQuestionGenerator(ctx);
}

/**
 * Refuse, before anything is written, a request that needs the model when the
 * deployment's configuration can make no call (2.1's reason: no key, ambient
 * SDK headers, no declared retention mode). 503 `AI_UNAVAILABLE`, its
 * `details.reason` naming which. Never a 500, and never questions faked.
 */
export function assertModelAvailable(generator: QuestionGenerator): void {
    const reason = generator.unavailableReason();
    if (reason) throw new AiUnavailableError(reason as AiUnavailableReason);
}

/**
 * Why a round that produced no question pauses its session, from the round's
 * calls (the table in `src/lib/interview/model-seam.ts`'s header):
 *
 *   GUARD_REFUSED           every call was refused by the guard
 *   PROVIDER_FAILURE        every call failed, and at least one for the
 *                           provider's sake (a timeout, an HTTP or connection
 *                           failure, a model refusal, a cancellation, or a
 *                           throw the seam could not name)
 *   NO_ACCEPTABLE_QUESTION  otherwise: the model answered, but nothing it said
 *                           (INVALID_OUTPUT: invalid after the repair, cut off,
 *                           no answer) or nothing the packs hold could be asked
 *
 * A model that answered wrongly is not a provider failure: the provider was
 * up, and saying so would send an operator looking in the wrong place.
 */
export function emptyRoundStopReason(m: Pick<RoundOutput['metrics'], 'generationCalls' | 'generationFailures' | 'failures'>): StopReason {
    const allFailed = m.generationCalls > 0 && m.generationFailures === m.generationCalls;
    if (!allFailed) return 'NO_ACCEPTABLE_QUESTION';
    const guarded = m.failures.GUARD ?? 0;
    if (guarded === m.generationCalls) return 'GUARD_REFUSED';
    // Every failure the seam did not put down to the guard or the answer itself.
    const byProvider = m.generationFailures - guarded - (m.failures.INVALID_OUTPUT ?? 0);
    return byProvider > 0 ? 'PROVIDER_FAILURE' : 'NO_ACCEPTABLE_QUESTION';
}

/** End a session with its reason, in the caller's transaction. */
export async function endSession(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    reason: StopReason,
    detail: Prisma.InputJsonValue,
    statusOverride?: 'STOPPED',
): Promise<void> {
    const status = statusOverride ?? STATUS_AFTER_STOP[reason];
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
    | { kind: 'claimed'; roundId: string; roundNumber: number; plan: RoundPlan; state: InterviewState; sourceContext: SourceContext; contextDeferred: boolean };

/** The scope's plain elements (no relation, no element not yet created): what the retriever reads facts and passages for. */
function scopeOf(state: InterviewState) {
    return state.elements.filter((e) => !e.relation && !e.pending).map((e) => ({ elementId: e.elementId, kind: e.kind, name: e.name }));
}

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
    // THE precedence is `decideStop`'s (`src/lib/interview/stop.ts`): the
    // frontier's own stop first — a session with nothing left to ask
    // COMPLETES saying so, even with the kill switch on or a budget spent
    // (owner decision 2026-11-19) — then the kill switch and the spend
    // ceiling, which pause only a session that would need the model, then the
    // token and round budgets.
    const reason = decideStop({
        ...signals,
        frontierStop: fromFrontier,
        tokenBudget: session.tokenBudget,
        tokensUsed: session.tokensUsed,
        nextRoundTokens: nextRoundTokens(session.personaKeys.length),
        authorStopped: false,
        roundBudget: session.roundBudget,
        roundsRun: session.roundsRun,
    });
    if (!reason) return null;
    return { reason, detail: stopDetailFor(reason, frontier, reason === fromFrontier ? { scopeElements: state.elements.length } : undefined) };
}

/** The session is already paused PACK_CHANGED for exactly these packs: a retry has nothing new to record. */
function alreadyPausedFor(session: SessionRow, detail: { problem: string; packs: readonly unknown[] }): boolean {
    if (session.status !== 'PAUSED' || session.stopReason !== 'PACK_CHANGED') return false;
    const stored = session.stopDetail as { problem?: unknown; packs?: unknown } | null;
    return stored?.problem === detail.problem && JSON.stringify(stored?.packs ?? null) === JSON.stringify(detail.packs);
}

/**
 * Plan the session's next round and claim it, or end the session. Runs under
 * the session's lock. Before claiming, the session's pinned packs are compared
 * with the ones this request would teach it (Phase 2.3, `pinMismatch`): a
 * pack that no longer mounts here refuses 503 `PACKS_NOT_MOUNTABLE` with
 * nothing written (a deployment condition, which clears when it is fixed); a
 * pack whose file changed since the session started — or one it never pinned
 * (a session from before pinning) — pauses it `PACK_CHANGED`.
 */
export async function claimRound(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    generator: QuestionGenerator,
    packs: PackContext,
    /** Phase 4.1: read the round's context now (lexical), or after the claim with a query embedding (`contextEmbedderOf`). */
    contextNow: boolean = true,
): Promise<ClaimOutcome> {
    const state = await loadInterviewState(db, ctx, session);
    for (const r of state.rounds) {
        if (r.status === 'OPEN') throw new ConflictError('Close the open round first.', { reason: 'ROUND_OPEN', roundNumber: r.number });
        if (r.status === 'GENERATING') {
            if (Date.now() - r.startedAt.getTime() < STALE_CLAIM_MS) throw new ConflictError('A round is being generated.', { reason: 'ROUND_GENERATING', roundNumber: r.number });
            await InterviewRoundRepository.update(db, ctx.workspaceId, r.id, { status: 'FAILED' });
        }
    }
    // The month must take the whole round: one call per persona (at most), each at its least.
    const stop = stopNow(session, state, await modelBudgetSignals(db, ctx, session.detail, nextRoundGenerationCalls(session.personaKeys.length)));
    if (stop) {
        await endSession(db, ctx, session, stop.reason, stop.detail);
        return { kind: 'stopped', reason: stop.reason };
    }
    assertModelAvailable(generator);
    const needed = packNamesForState(state, session.personaKeys as PersonaKey[]);
    const problem = pinMismatch(parsePackPins(session.packPins), needed, packs.registry, await packs.mounts(needed));
    if (problem?.reason === 'PACK_NOT_MOUNTABLE') {
        throw new PacksNotMountableError(problem.packs);
    }
    if (problem) {
        const detail = { problem: problem.reason, packs: problem.packs };
        if (problem.reason === 'PACK_NOT_PINNED') {
            // A session from before pinning (2.2) can never be pinned (the pins
            // are write-once; one written now would be a reconstruction), so no
            // deployment will ever resume it: it ENDS, once, and a later request
            // meets an ended interview (409 INTERVIEW_ENDED) and writes nothing
            // (issue #36, item 2).
            await endSession(db, ctx, session, 'PACK_CHANGED', detail, 'STOPPED');
        } else if (!alreadyPausedFor(session, detail)) {
            // A changed pack pauses (a deployment that restores the file lets it
            // resume); asked again while still changed, it is already paused for
            // exactly this, and nothing is written again (issue #36, item 2).
            await endSession(db, ctx, session, 'PACK_CHANGED', detail);
        }
        return { kind: 'stopped', reason: 'PACK_CHANGED' };
    }
    const { frontier, plan } = planOf(state, session);
    // The workspace's model-call rate (issue #32, item 5): one unit per generation call the round will make, before it is claimed.
    chargeModelCalls(ctx.workspaceId, nextRoundGenerationCalls(session.personaKeys.length));
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
    // Phase 4.0 / 4.1: the round's context (related summaries, the top facts, the most relevant passages). With no
    // query embedder it is read here, in the claim's own transaction, lexically (no extra round trip before the
    // first question). With one, it is read AFTER the claim (`withQueryContext`): the query is embedded outside
    // every transaction — never a provider call inside one — and the context read in one transaction more.
    const sourceContext = contextNow ? await assembleSourceContext(db, ctx, session.bookId, scopeOf(state), null, undefined, state.related) : EMPTY_SOURCE_CONTEXT;
    return { kind: 'claimed', roundId: round.id, roundNumber, plan, state, sourceContext, contextDeferred: !contextNow };
}

/** The embedder a round's context query uses (Phase 4.1, D27): the deps' (`null`: none), else the deployment's. */
export function contextEmbedderOf(deps: InterviewDeps): QuestionEmbedder | null {
    return deps.embedder === undefined ? defaultQuestionEmbedder() : deps.embedder;
}

/** The text a round's context query embeds: the scope's names and the round's targets, short, never an answer. */
export function contextQueryText(claim: Extract<ClaimOutcome, { kind: 'claimed' }>): string {
    const names = [...new Set(claim.state.elements.map((e) => e.name).filter((n) => n.trim() !== ''))];
    const targets = [...new Set(claim.plan.targets.map((t) => t.fieldKey.replace(/_/g, ' ')))];
    return [...names, ...targets].join(' ').slice(0, 400);
}

/**
 * The deferred context (Phase 4.1, D27): embed the query in the deployment (D8), OUTSIDE every transaction, then
 * read the context in one transaction with it — vector hits (filtered to the book's allowed set in the query) fused
 * with the lexical ranker's. An embedding that fails reads the context lexically: it never fails the round.
 */
async function withQueryContext(ctx: WorkspaceRequestContext, session: SessionRow, claim: Extract<ClaimOutcome, { kind: 'claimed' }>, embedder: QuestionEmbedder | null): Promise<SourceContext> {
    let query: { vector: readonly number[]; revision: string } | null = null;
    if (embedder) {
        const [vector] = await embedder.embed([contextQueryText(claim)]);
        if (vector) query = { vector, revision: embedder.revision };
    }
    return runInWorkspaceContext(ctx, (db) => assembleSourceContext(db, ctx, session.bookId, scopeOf(claim.state), query, undefined, claim.state.related));
}

/**
 * The packs a session's subjects are questioned with, by name (Phase 3.3): the
 * craft pack of each element kind (the element not yet created's too), the
 * relations pack when a relation is in scope, and each persona's.
 */
export function packNamesForState(state: Pick<InterviewState, 'elements'>, personaKeys: readonly PersonaKey[]): string[] {
    const kinds = [...new Set(state.elements.filter((e) => !e.relation).map((e) => e.kind))];
    return packNamesFor(kinds, personaKeys, { relations: state.elements.some((e) => e.relation) });
}

/** The questions whose ANSWERED answers settled `q`'s prerequisites in this session (derived; display and audit). */
function dependsOnQuestionIds(q: PlannedQuestion, state: InterviewState): string[] {
    const element = state.elements.find((e) => e.elementId === q.elementId);
    if (!element) return [];
    const prereqs = new Set(q.targetsFieldKeys.flatMap((k) => element.fields.find((f) => f.key === k)?.dependsOn ?? []));
    return state.questions
        .filter((asked) => subjectIdOf(asked) === q.elementId && asked.targetsFieldKeys.some((k) => prereqs.has(k)) && state.latest.get(asked.id)?.status === 'ANSWERED')
        .map((asked) => asked.id);
}

/** Generate the claimed round and persist it (or fail it). Returns once the round is OPEN or FAILED. */
export async function generateClaimedRound(
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    claim: Extract<ClaimOutcome, { kind: 'claimed' }>,
    deps: InterviewDeps,
): Promise<void> {
    const generator = generatorOf(ctx, deps);
    const embedder = contextEmbedderOf(deps);
    const packs = deps.packs ?? getPacks();
    const { state, plan } = claim;
    const sourceContext = claim.contextDeferred ? await withQueryContext(ctx, session, claim, embedder) : claim.sourceContext;
    const known = new Set(state.asked.map((q) => q.id));

    let output: RoundOutput;
    try {
        output = await produceRound(
            {
                bookId: session.bookId,
                dials: { depth: session.depth, detail: session.detail },
                offerRecommended: session.offerRecommended,
                preferChoice: session.preferChoice,
                personaKeys: session.personaKeys,
                plan,
                elements: state.elements,
                // The related summaries the context's budget kept (4.1), else the state's.
                related: sourceContext.related ? [...sourceContext.related] : state.related,
                sessionAnswers: state.promptAnswers,
                asked: state.asked,
                packs,
                sourceContext,
                // The cosine thresholds of the embedder's revision (issue #32 item 1): calibrated, configured, or the uncalibrated default.
                cosineThresholds: embedder ? cosineThresholdsFor(embedder.revision, env.DEDUPE_COSINE_THRESHOLDS) : undefined,
            },
            {
                generator,
                embed: embedder ? (texts) => embedder.embed(texts) : undefined,
                findNeighbours: embedder ? (vectors) => neighboursOrNone(ctx, session.bookId, embedder.revision, vectors, known) : undefined,
                findExactRepeats: (probes) => exactRepeatsOrNone(ctx, session.bookId, probes, new Set(state.elements.filter((e) => e.relation).map((e) => e.elementId))),
                observer: streamObserver(deps.stream),
                signal: deps.signal,
            },
        );
    } catch (err) {
        // A stop of the whole session (2.1's kill switch, the spend ceiling, a
        // configuration that can make no call): the round is abandoned — none
        // of it is asked — its tokens are charged, and the session pauses with
        // the named reason. The request answers with the session, not an error.
        const stopped = err instanceof GenerationStop ? err : null;
        await runInWorkspaceContext(ctx, async (db) => {
            await InterviewSessionRepository.lock(db, session.id);
            await InterviewRoundRepository.update(db, ctx.workspaceId, claim.roundId, { status: 'FAILED' });
            const current = await InterviewSessionRepository.find(db, ctx.workspaceId, session.bookId, session.id);
            if (current && stopped && stopped.tokensUsed > 0) await InterviewSessionRepository.addTokens(db, ctx.workspaceId, session.id, Math.min(stopped.tokensUsed, TOKENS_PER_CALL_REPORT_MAX));
            if (current?.status === 'ACTIVE') {
                await endSession(
                    db,
                    ctx,
                    current,
                    stopped ? stopped.reason : 'PROVIDER_FAILURE',
                    stopped ? { roundNumber: claim.roundNumber, errorCode: stopped.errorCode, ...(stopped.callId ? { aiCallId: stopped.callId } : {}) } : { roundNumber: claim.roundNumber },
                );
            }
        });
        if (stopped) return;
        throw err;
    }

    if (deps.signal?.aborted) {
        // The author went away mid-round (the stream was cancelled): nothing of
        // the round is asked. It is abandoned — FAILED, what its calls spent
        // charged — and the session is left as it stands, so the next round
        // resumes it. No stop is recorded: nothing about the session stopped.
        await runInWorkspaceContext(ctx, async (db) => {
            await InterviewSessionRepository.lock(db, session.id);
            const round = await InterviewRoundRepository.find(db, ctx.workspaceId, session.id, claim.roundId);
            if (round?.status === 'GENERATING') await InterviewRoundRepository.update(db, ctx.workspaceId, claim.roundId, { status: 'FAILED', metrics: { ...output.metrics, cancelled: true } as unknown as Prisma.InputJsonValue });
            if (output.metrics.tokensUsed > 0) await InterviewSessionRepository.addTokens(db, ctx.workspaceId, session.id, output.metrics.tokensUsed);
        });
        logger.info('interview.round_cancelled', { component: 'interview', sessionId: session.id, roundNumber: claim.roundNumber, calls: output.metrics.generationCalls });
        return;
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
        const askable = await stillAskable(db, ctx, session, output.questions);
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
            const m = output.metrics;
            const allFailed = m.generationCalls > 0 && m.generationFailures === m.generationCalls;
            await endSession(db, ctx, current, emptyRoundStopReason(m), {
                roundNumber: claim.roundNumber,
                noQuestion: m.noQuestion.length,
                ...(allFailed ? { failures: m.failures, aiCallIds: m.aiCallIds } : {}),
            });
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
                ...storedSubject(q.elementId, state, session),
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
                reviewRequired: planned.reviewRequired,
            });
            const vector = output.vectors.get(askable[planned.position - 1].position);
            if (vector && embedder) records.push(questionRecord(ctx.workspaceId, created.id, session.bookId, created.text, vector, embedder.revision));
        }
        await InterviewRoundRepository.update(db, ctx.workspaceId, claim.roundId, { status: 'OPEN', openedAt: new Date(), metrics });
        recordRoundRepetition({ asked: questions.length, duplicates: output.metrics.duplicates });
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
 * Where a question about this subject is filed (Phase 3.3, `subjects.ts`): an
 * element's under the element; a relation's under its declaring element with
 * `relationId`; the element not yet created's under the slot's earlier
 * neighbour with `aboutPending`.
 */
export function storedSubject(subjectId: string, state: Pick<InterviewState, 'elements'>, session: Pick<SessionRow, 'slotAfterElementId'>): { elementId: string; relationId: string | null; aboutPending: boolean } {
    const subject = state.elements.find((e) => e.elementId === subjectId);
    if (subject?.relation) return { elementId: subject.relation.fromElementId, relationId: subject.relation.relationId, aboutPending: false };
    if (subject?.pending || subjectId === PENDING_SUBJECT_ID) return { elementId: session.slotAfterElementId!, relationId: null, aboutPending: true };
    return { elementId: subjectId, relationId: null, aboutPending: false };
}

/**
 * The produced questions the book still lets this round ask, in order: the
 * subject still exists (an element, a relation, or the slot's neighbours), a
 * FRONTIER question's fields are all still empty (rule 5), and a CHALLENGE's
 * quote is still a verbatim run of its stored value. Read again under the
 * session's lock (Phase 3.3: through the session's own state, which reads
 * every kind of subject the way the round was planned).
 */
async function stillAskable(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, questions: readonly PlannedQuestion[]): Promise<PlannedQuestion[]> {
    const now = await loadInterviewState(db, ctx, session);
    const subjects = new Map(now.elements.map((e) => [e.elementId, e] as const));
    const answeredByCheck = new Set(frontierOf(now, session.depth).answered.filter((a) => a.by !== 'bible-values').map((a) => `${a.elementId}\u0000${a.fieldKey}`));
    return questions.filter((q) => {
        const subject = subjects.get(q.elementId);
        if (!subject) return false;
        const values = subject.storedText;
        if (q.mode === 'CHALLENGE') {
            const value = values.get(q.targetsFieldKeys[0]);
            return value !== undefined && q.challengeQuote !== null && isVerbatimQuote(q.challengeQuote, value);
        }
        return q.targetsFieldKeys.every((k) => !values.has(k) && !answeredByCheck.has(`${q.elementId}\u0000${k}`));
    });
}

/** The book's exact repeats among these probes, or none when the read fails (deduplication keeps its other signals). */
async function exactRepeatsOrNone(
    ctx: WorkspaceRequestContext,
    bookId: string,
    probes: ReadonlyArray<{ elementId: string; dedupeKey: string }>,
    relationIds: ReadonlySet<string>,
): Promise<Set<string>> {
    try {
        // Phase 3.3: a relation's probe names its relation; the element not yet created has no earlier question anywhere in the book.
        const asked = probes.filter((p) => p.elementId !== PENDING_SUBJECT_ID).map((p) => ({ ...p, relation: relationIds.has(p.elementId) }));
        const rows = await runInWorkspaceContext(ctx, (db) => QuestionRepository.findExactRepeats(db, ctx.workspaceId, bookId, asked));
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
