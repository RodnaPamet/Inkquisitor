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
import { BibleElementRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { StoryFactRepository } from '@/app-layer/repositories/source.repository';
import { FactProposalRepository } from '@/app-layer/repositories/fact-layer.repository';
import { StoryThreadRepository } from '@/app-layer/repositories/continuity.repository';
import { bookSourceSet } from './source-common';
import { orderRoundTies, type QuestionOrderDeps, type QuestionOrderMetrics } from './interview-question-order';
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
import { generatorsOn, nextRoundTokens } from '@/lib/interview/dial-settings';
import { CHALLENGES_PER_SESSION, candidateKey, planRound, type RoundPlan, type WordedTarget } from '@/lib/interview/plan';
import { DETAIL, roundCapFor } from '@/lib/interview/dials';
import { REPHRASES_PER_ROUND_MAX } from '@/lib/interview/rephrase';
import { generateCandidates, type GeneratorInput, type GeneratorSubject } from '@/lib/interview/generators';
import { selectCandidates, type Selection } from '@/lib/interview/generators/select';
import { MINOR_VALUE_FLOOR } from '@/lib/interview/generators/value';
import { compactedThrough, compactionSkip, DEFAULT_COMPACTION, summaryRequestBlocks } from '@/lib/interview/compaction';
import { compactionCallWorstTokens } from '@/lib/interview/compaction-seam';
import { relationFieldDefs } from '@/lib/bible/templates';
import { loadGeneratorInputs } from './interview-generators';
import { STALE_CHALLENGES_MAX } from '@/lib/continuity/vocabulary';
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
import { PENDING_SUBJECT_ID, pairOfSubject, pairSubjectId, subjectIdOf } from '@/lib/interview/subjects';
import { assembleSourceContext, EMPTY_SOURCE_CONTEXT, type SourceContext } from './source-retrieval';
import { compactedSessionFor, roundAnswersOf, type CompactionDeps } from './interview-compaction';
import { refKey, type FieldRef, type FrontierEntry } from '@/lib/interview/frontier';
import { challengeableOf, frontierOf, frontierStop, loadInterviewState, nextRoundNumber, SESSION_QUESTIONS_MAX, stopDetailFor, type InterviewState } from './interview-state';

/** A pair's fields (Phase 4.4): the built-in `related_to`'s, which a NEW_RELATION from its answer would fill. */
const PAIR_FIELDS = relationFieldDefs('CHARACTER', 'related_to');
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
export interface InterviewDeps extends Omit<CompactionDeps, 'packRecordMode'> {
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
    /** Phase 4.4 (D30 item 4): the tie-break's orderer (tests); omitted: the deployment's over 2.1. */
    orderer?: QuestionOrderDeps['orderer'];
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

/** The most questions one round can hold: its cap at the highest detail, one challenge, and every rephrase it may take (Phase 4.4). */
export const ROUND_QUESTIONS_WORST = Math.max(...Object.values(DETAIL).map((d) => d.roundCap)) + 1 + REPHRASES_PER_ROUND_MAX;

/** A round as planned from the generators (Phase 4.4): the frontier, the plan, the generators' selection, the model calls it needs. */
export interface PlannedRound {
    frontier: FrontierResult;
    plan: RoundPlan;
    selection: Selection;
    /** Generation calls the round will make: one per persona holding a share of its model-worded targets (0 for a round code worded alone). */
    modelCalls: number;
    /** The generator inputs it was planned from (the persist re-reads the book against them). */
    inputs: GeneratorInput;
}

/**
 * The generators' inputs with only the frontier (what a pure caller has without the database): the FRONTIER generator
 * and a relation's empty fields, the generators that read nothing beyond the loaded state. The others need the
 * book's history and facts (`loadGeneratorInputs`).
 */
export function frontierOnlyInputs(session: SessionRow, state: InterviewState, frontier: FrontierResult): GeneratorInput {
    const on = generatorsOn(session.generatorsOff ?? []);
    return {
        depth: session.depth,
        detail: session.detail,
        enabled: new Set([...on].filter((g) => g === 'FRONTIER' || g === 'RELATIONS')),
        subjects: state.elements,
        frontier,
        ladder: { answered: new Set(), askedInSession: new Set() },
        factsHeld: new Map(),
        pairs: [],
        pendingFacts: [],
        continuity: [],
    };
}

/** The questions a QUESTIONS session has asked (a rephrase stands in for the question it replaced). */
export function questionsAsked(state: Pick<InterviewState, 'questions'>): number {
    return state.questions.filter((q) => q.supersededAt === null).length;
}

/**
 * THE ROUND'S PLAN (Phase 4.4, D23 and D30): every generator's candidates, selected by code — validated, deduplicated,
 * best value first, cut to the round's room — then 2.2's persona deal and challenge over the model-worded ones. Pure
 * over a loaded state and the generators' inputs.
 */
export function planFromInputs(session: SessionRow, state: InterviewState, inputs: GeneratorInput): PlannedRound {
    const frontier = inputs.frontier;
    const challengeable = challengeableOf(frontier, session.depth);
    // Phase 4.2 (D28): a grill on what changed challenges the stale entry's fields first, one a round, each once.
    // Phase 4.3 (D29): a session from a stress test challenges the fields its weak points bear on first, the same way.
    const focus = state.stale ? [{ elementId: state.stale.elementId, fieldKeys: state.stale.fieldKeys }] : (state.weakPoints?.focus ?? []);
    const focused = (r: FieldRef) => focus.some((f) => f.elementId === r.elementId && f.fieldKeys.includes(r.fieldKey));
    const focusFields = focus.reduce((n, f) => n + f.fieldKeys.length, 0);
    // HOLD FOLLOW-UPS (owner decision 2026-11-26, A): a stored value whose proposed change is still pending is not challenged either.
    const held = inputs.heldByProposals ?? new Set<string>();
    const open = challengeable.filter((r) => !held.has(refKey(r)));
    const staleFirst = focus.length > 0 ? [...open.filter(focused), ...open.filter((r) => !focused(r))] : open;

    const left = session.lengthMode === 'QUESTIONS' && session.questionBudget !== null ? Math.max(0, session.questionBudget - questionsAsked(state)) : Number.POSITIVE_INFINITY;
    const cap = Math.min(roundCapFor(session.detail), left);
    const subjects = new Map<string, Pick<GeneratorSubject, 'elementId' | 'fields'>>(state.elements.map((e) => [e.elementId, e] as const));
    for (const p of inputs.pairs) subjects.set(pairSubjectId(p.firstElementId, p.secondElementId), { elementId: pairSubjectId(p.firstElementId, p.secondElementId), fields: PAIR_FIELDS });
    const selection = selectCandidates(generateCandidates(inputs), { cap, floor: session.minorAccepted ? 0 : MINOR_VALUE_FLOOR, subjects, held });

    const byId = new Map(state.elements.map((e) => [e.elementId, e] as const));
    const modelTargets: FrontierEntry[] = selection.chosen.flatMap((c) => {
        const subject = byId.get(c.elementId);
        if (c.worded !== null || c.fieldKey === null || !subject) return [];
        return [{ elementId: c.elementId, fieldKey: c.fieldKey, kind: subject.kind, level: c.level, required: c.required, generator: c.generator, value: c.value } as FrontierEntry];
    });
    const worded = selection.chosen.filter((c): c is WordedTarget => c.worded !== null);
    const plan = planRound({
        frontier: modelTargets,
        challengeable: staleFirst,
        ...(focus.length > 0 ? { challengeAlways: true, challengesMax: Math.min(STALE_CHALLENGES_MAX, Math.max(CHALLENGES_PER_SESSION, focusFields)) } : {}),
        challenged: state.challenged,
        challengesPlanned: state.challengesPlanned,
        depth: session.depth,
        detail: session.detail,
        personaKeys: session.personaKeys,
        roundNumber: nextRoundNumber(state),
        // A challenge is allowed by the frontier's own size (2.2's rule); it never displaces a candidate, whatever its generator.
        frontierSize: frontier.frontier.length,
        // A QUESTIONS session's last round asks no more than it has left: no challenge once its room is spent.
        allowChallenge: selection.chosen.length < left,
    });
    const rank = new Map(selection.chosen.map((c, i) => [candidateKey(c), i] as const));
    const withGenerators: RoundPlan = { ...plan, worded, rank };
    const shares = session.personaKeys.length === 0 ? [null] : session.personaKeys;
    const modelCalls = shares.filter((p) => withGenerators.targets.some((t) => t.personaKey === p) || withGenerators.challenge?.personaKey === p).length;
    return { frontier, plan: withGenerators, selection, modelCalls, inputs };
}

/** The round's plan with the generators' inputs read in the caller's transaction (Phase 4.4). */
export async function planSession(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, state: InterviewState): Promise<PlannedRound> {
    const frontier = frontierOf(state, session.depth);
    return planFromInputs(session, state, await loadGeneratorInputs(db, ctx, session, state, frontier));
}

/**
 * The tokens long-session compaction may spend before this round (Phase 4.4: compaction is on): its summary call's
 * worst case when the round will compact, else 0. Reserved beside the round in the token-budget check, so a session is
 * stopped TOKEN_BUDGET before a round whose summary would not fit rather than generating it uncompacted.
 */
export function compactionReserveTokens(state: InterviewState, roundNumber: number): number {
    const answers = roundAnswersOf(state).filter((a) => a.roundNumber < roundNumber);
    if (compactionSkip(DEFAULT_COMPACTION, answers)) return 0;
    return compactionCallWorstTokens(summaryRequestBlocks(answers, compactedThrough(answers)));
}

/**
 * Would the session stop now, and why (the precedence below)? Pure over a loaded state; `planned` is the round's plan
 * from the generators (`planSession`), or the frontier alone when omitted.
 */
export function stopNow(
    session: SessionRow,
    state: InterviewState,
    signals: { killSwitch: boolean; workspaceCeilingReached: boolean } = { killSwitch: false, workspaceCeilingReached: false },
    planned: PlannedRound = planFromInputs(session, state, frontierOnlyInputs(session, state, frontierOf(state, session.depth))),
): { reason: StopReason; detail: Prisma.InputJsonValue } | null {
    const { frontier, plan, selection, modelCalls } = planned;
    const wordedCount = plan.worded?.length ?? 0;
    // Nothing left to ask means no candidate at all: a plan emptied only by its room (a QUESTIONS session's spent
    // budget) is that budget's stop, never FRONTIER_EMPTY.
    // Nothing chosen while some candidates wait on the author's decision of a proposed change (owner decision
    // 2026-11-26, A): the session is not done, it waits (AWAITING_DECISIONS), and asks them once decided.
    const awaitingDecisions = selection.held > 0 && selection.chosen.length === 0 && !plan.challenge;
    const fromFrontier = selection.valueFell || wordedCount > 0 || selection.remaining > 0 || awaitingDecisions ? null : frontierStop(frontier, plan);
    // THE precedence is `decideStop`'s (`src/lib/interview/stop.ts`): the
    // frontier's own stop first — a session with nothing left to ask
    // COMPLETES saying so, even with the kill switch on or a budget spent
    // (owner decision 2026-11-19) — then the kill switch and the spend
    // ceiling, which pause only a session that would need the model (Phase
    // 4.4: a round of code-worded questions alone needs none), then the token
    // budget, the session's length, and last VALUE_FELL (D30).
    const reason = decideStop({
        ...(modelCalls > 0 ? signals : { killSwitch: false, workspaceCeilingReached: false }),
        frontierStop: fromFrontier,
        tokenBudget: session.tokenBudget,
        tokensUsed: session.tokensUsed,
        nextRoundTokens: nextRoundTokens(session.personaKeys.length, modelCalls) + compactionReserveTokens(state, nextRoundNumber(state)),
        authorStopped: false,
        roundBudget: session.lengthMode === 'ROUNDS' ? session.roundBudget : null,
        roundsRun: session.roundsRun,
        questionBudget: session.lengthMode === 'QUESTIONS' ? session.questionBudget : null,
        questionsAsked: questionsAsked(state),
        sessionLimitReached: state.questions.length + ROUND_QUESTIONS_WORST > SESSION_QUESTIONS_MAX,
        awaitingDecisions,
        valueFell: selection.valueFell && !session.minorAccepted,
    });
    if (!reason) return null;
    const extra =
        reason === fromFrontier
            ? { scopeElements: state.elements.length }
            : reason === 'VALUE_FELL'
              ? { minor: selection.minor }
              : reason === 'AWAITING_DECISIONS'
                ? { held: selection.held }
              : reason === 'QUESTION_BUDGET'
                ? { questionsAsked: questionsAsked(state) }
                : reason === 'SESSION_LIMIT'
                  ? { questions: state.questions.length, max: SESSION_QUESTIONS_MAX }
                  : undefined;
    return { reason, detail: stopDetailFor(reason, frontier, extra) };
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
    // Phase 4.4 (D23, D30): the round's plan from every generator, best value first.
    const planned = await planSession(db, ctx, session, state);
    // The month must take the whole round: one call per persona holding a share (at most), each at its least.
    const stop = stopNow(session, state, planned.modelCalls > 0 ? await modelBudgetSignals(db, ctx, session.detail, planned.modelCalls) : undefined, planned);
    if (stop) {
        // Asked again while already paused for exactly this (a "next round" without `goOn`): nothing new to record.
        // Likewise while it still waits on the author's decisions (AWAITING_DECISIONS).
        const alreadyWaiting = (stop.reason === 'VALUE_FELL' || stop.reason === 'AWAITING_DECISIONS') && session.status === 'PAUSED' && session.stopReason === stop.reason;
        if (!alreadyWaiting) await endSession(db, ctx, session, stop.reason, stop.detail);
        return { kind: 'stopped', reason: stop.reason };
    }
    if (planned.modelCalls > 0) assertModelAvailable(generator);
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
    const { frontier, plan, selection } = planned;
    // The workspace's model-call rate (issue #32, item 5): one unit per generation call the round will make, before it is claimed.
    if (planned.modelCalls > 0) chargeModelCalls(ctx.workspaceId, planned.modelCalls);
    const roundNumber = nextRoundNumber(state);
    const round = await InterviewRoundRepository.create(db, ctx.workspaceId, {
        sessionId: session.id,
        number: roundNumber,
        promptVersion: QUESTION_PROMPT_VERSION,
        plan: storedPlan(plan, frontier, selection),
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

/**
 * The plan as the round row stores it: field references, levels, generators, value scores and ids — never a
 * code-worded question's text, which quotes the author (Phase 4.4).
 */
export function storedPlan(plan: RoundPlan, frontier: FrontierResult, selection: Selection): Prisma.InputJsonValue {
    return {
        cap: plan.cap,
        targets: plan.targets.map((t) => ({ elementId: t.elementId, fieldKey: t.fieldKey, level: t.level, personaKey: t.personaKey, generator: t.generator ?? 'FRONTIER', value: t.value ?? null })),
        carried: plan.carried.map((t) => ({ elementId: t.elementId, fieldKey: t.fieldKey, level: t.level })),
        challenge: plan.challenge ? { ...plan.challenge } : null,
        worded: (plan.worded ?? []).map((w) => ({
            generator: w.generator,
            elementId: w.elementId,
            fieldKey: w.fieldKey,
            value: w.value,
            ...(w.angle ? { angle: w.angle } : {}),
            ...(w.pairElementId ? { pairElementId: w.pairElementId } : {}),
            ...(w.storyFactId ? { storyFactId: w.storyFactId } : {}),
            ...(w.continuityRef ? { continuityRef: w.continuityRef } : {}),
        })),
        frontierSize: frontier.frontier.length,
        blocked: frontier.blocked.length,
        generators: { proposed: selection.proposed, refused: selection.refused, duplicates: selection.duplicates, remaining: selection.remaining, minor: selection.minor, held: selection.held },
    } as unknown as Prisma.InputJsonValue;
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
    const read = (q: typeof query) => runInWorkspaceContext(ctx, (db) => assembleSourceContext(db, ctx, session.bookId, scopeOf(claim.state), q, undefined, claim.state.related));
    if (!query) return read(null);
    try {
        return await read(query);
    } catch (err) {
        // The vector half failed (the store refused the query): the context is read lexically, as with no embedder.
        logger.warn('interview.context_vector_failed', { component: 'interview', sessionId: session.id, error: err instanceof Error ? err.name : 'unknown' });
        return read(null);
    }
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
    const { state } = claim;
    let plan = claim.plan;
    let orderMetrics: QuestionOrderMetrics = { status: 'CODE', reason: 'NOT_RUN' };
    const known = new Set(state.asked.map((q) => q.id));

    let output: RoundOutput;
    try {
        // Read inside the try: the round is claimed, so a context that cannot be read FAILS the round (and pauses the
        // session, named) rather than leaving it GENERATING until its claim goes stale.
        const sourceContext = claim.contextDeferred ? await withQueryContext(ctx, session, claim, embedder) : claim.sourceContext;
        // A request handed its own generator (a test, the evaluation) runs the deployment's other model steps only when it
        // hands them in too: compaction (on since 4.4) needs its `compaction` settings or a summarizer, the tie-break its
        // orderer. So a test never reaches a provider through a step it did not wire.
        const ownGenerator = deps.generator !== undefined;
        const compacted = await compactedSessionFor(ctx, session, claim, {
            ...deps,
            packRecordMode: deps.packRecordMode,
            ...(ownGenerator && !deps.compaction && !deps.summarizer ? { compaction: { ...DEFAULT_COMPACTION, enabled: false } } : {}),
        });
        // Phase 4.4 (D30, item 4): a cheap model call may reorder the round's NEAR-EQUAL candidates; the code's order
        // stands, recorded with its reason, whenever it cannot (or need not) be made.
        const ordered = ownGenerator && !deps.orderer ? { plan, metrics: { status: 'CODE' as const, reason: 'NOT_RUN' as const } } : await orderRoundTies(ctx, session, claim, deps);
        plan = ordered.plan;
        orderMetrics = ordered.metrics;
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
                // Phase 4.2 (D28): a grill on what changed carries the change as one more data block.
                // Phase 4.3 (D29): a session from a stress test carries its weak points as one more data block.
                sourceContext: {
                    ...sourceContext,
                    ...(state.stale ? { upstreamChange: state.stale.changeText } : {}),
                    ...(state.weakPoints ? { weakPoints: state.weakPoints.text } : {}),
                },
                // Phase 4.3: a long session's earlier rounds, compacted (the state block and the summary; off by default).
                ...(compacted ? { compacted } : {}),
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
        const stillThere = await stillAskable(db, ctx, session, output.questions);
        // THE HARD REPETITION GATE (Phase 4.4, D23): under the book's question lock, a question the book already holds in
        // these words (its subject and keyed dedupe key) — or one the round itself holds twice — is not asked. Whatever
        // reached this point through a degraded read (the vector store, the exact-repeat index) stops here.
        await InterviewSessionRepository.lockBookQuestions(db, session.bookId);
        const textCtx = { elementNames: new Map(state.elements.map((e) => [e.elementId, e.name])) };
        const askable = await withoutRepeats(db, ctx, session, stillThere, textCtx, new Set(state.elements.filter((e) => e.relation).map((e) => e.elementId)));
        const questions = askable.map((q, i) => ({ ...q, position: i + 1 }));
        const metrics = {
            ...output.metrics,
            staleAtPersist: output.questions.length - stillThere.length,
            repeatsBlocked: stillThere.length - askable.length,
            order: orderMetrics,
        } as unknown as Prisma.InputJsonValue;

        if (questions.length === 0) {
            await InterviewRoundRepository.update(db, ctx.workspaceId, claim.roundId, { status: 'FAILED', metrics });
            if (output.questions.length > 0) {
                // Everything it worded was overtaken by the book: say what the book now says.
                const after = await InterviewSessionRepository.find(db, ctx.workspaceId, session.bookId, session.id);
                const afterState = after ? await loadInterviewState(db, ctx, after) : null;
                const stop = after && afterState ? stopNow(after, afterState, undefined, await planSession(db, ctx, after, afterState)) : null;
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

        const records: VectorRecord[] = [];
        const targetMeta = new Map(plan.targets.map((t) => [`${t.elementId}\u0000${t.fieldKey}`, t] as const));
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
                ...generatorColumns(planned, targetMeta),
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
export function storedSubject(
    subjectId: string,
    state: Pick<InterviewState, 'elements'>,
    session: Pick<SessionRow, 'slotAfterElementId'>,
): { elementId: string; relationId: string | null; aboutPending: boolean; pairElementId?: string | null } {
    const subject = state.elements.find((e) => e.elementId === subjectId);
    if (subject?.relation) return { elementId: subject.relation.fromElementId, relationId: subject.relation.relationId, aboutPending: false };
    if (subject?.pending || subjectId === PENDING_SUBJECT_ID) return { elementId: session.slotAfterElementId!, relationId: null, aboutPending: true };
    // Phase 4.4 (D30): a pair is filed under its first element, naming the second.
    const pair = pairOfSubject(subjectId);
    if (pair) return { elementId: pair.firstElementId, relationId: null, aboutPending: false, pairElementId: pair.secondElementId };
    return { elementId: subjectId, relationId: null, aboutPending: false };
}

/** A question's generator columns (Phase 4.4): a code-worded one's own; a model's (or the pack's) from the plan target it asks. */
export function generatorColumns(q: PlannedQuestion, targets: ReadonlyMap<string, { generator?: string; value?: number }>) {
    const g = q.generated;
    if (g) {
        return {
            generator: g.generator,
            angle: g.angle ?? null,
            pairElementId: g.pairElementId ?? null,
            storyFactId: g.storyFactId ?? null,
            continuityRef: g.continuityRef ?? null,
            valueScore: g.value,
        };
    }
    const t = q.mode === 'CHALLENGE' ? undefined : targets.get(`${q.elementId}\u0000${q.targetsFieldKeys[0]}`);
    return { generator: (t?.generator === 'RELATIONS' ? 'RELATIONS' : 'FRONTIER') as 'RELATIONS' | 'FRONTIER', valueScore: t?.value ?? null };
}

/**
 * The produced questions the book still lets this round ask, in order: the
 * subject still exists (an element, a relation, the slot's neighbours, or both
 * of a pair's elements), a FRONTIER question's fields are all still empty
 * (rule 5), and a CHALLENGE's quote is still a verbatim run of its stored
 * value. Read again under the session's lock (Phase 3.3: through the session's
 * own state, which reads every kind of subject the way the round was planned).
 *
 * Phase 4.4 (D30), each generator's own: a SOURCE question's fact is still
 * pending and unflagged in the book's source set; a CONTINUITY question's
 * contradiction still pending, thread still open, or gap's field still empty;
 * a pair still holds no relation; a LADDER question's field is still held.
 */
async function stillAskable(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, questions: readonly PlannedQuestion[]): Promise<PlannedQuestion[]> {
    const now = await loadInterviewState(db, ctx, session);
    const subjects = new Map(now.elements.map((e) => [e.elementId, e] as const));
    const frontier = frontierOf(now, session.depth);
    const answeredByCheck = new Set(frontier.answered.filter((a) => a.by !== 'bible-values').map((a) => `${a.elementId}\u0000${a.fieldKey}`));
    const held = new Set([...frontier.answered, ...frontier.answeredInSession].map((a) => `${a.elementId}\u0000${a.fieldKey}`));
    const factIds = [...new Set(questions.map((q) => q.generated?.storyFactId).filter((id): id is string => !!id))];
    const set = factIds.length > 0 ? await bookSourceSet(db, ctx, session.bookId) : null;
    const pendingFacts = factIds.length > 0 && set ? new Set(await StoryFactRepository.pendingAmong(db, ctx.workspaceId, factIds, [...set.bookSourceIds, ...set.seriesSourceIds])) : new Set<string>();
    const refs = questions.map((q) => q.generated?.continuityRef).filter((r): r is string => !!r);
    const openBases = refs.length > 0 ? await openContinuityBases(db, ctx, session.bookId, refs) : new Set<string>();
    const pairs = questions.flatMap((q) => (pairOfSubject(q.elementId) ? [pairOfSubject(q.elementId)!] : []));
    const pairIds = [...new Set(pairs.flatMap((p) => [p.firstElementId, p.secondElementId]))];
    const liveElements = pairIds.length > 0 ? new Set((await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, pairIds)).map((e) => e.id)) : new Set<string>();
    const related = new Set<string>();
    if (pairIds.length > 0) for (const r of await BibleRelationRepository.listBetween(db, ctx.workspaceId, session.bookId, pairIds, PAIR_PERSIST_RELATIONS_READ)) related.add([r.fromElementId, r.toElementId].sort().join('\u0000'));
    return questions.filter((q) => {
        const g = q.generated;
        if (g?.generator === 'SOURCES') return !!g.storyFactId && pendingFacts.has(g.storyFactId) && subjects.has(q.elementId);
        if (g?.generator === 'RELATIONS' && g.pairElementId) {
            const pair = pairOfSubject(q.elementId);
            return !!pair && liveElements.has(pair.firstElementId) && liveElements.has(pair.secondElementId) && !related.has([pair.firstElementId, pair.secondElementId].sort().join('\u0000'));
        }
        const subject = subjects.get(q.elementId);
        if (!subject) return false;
        const values = subject.storedText;
        if (g?.generator === 'LADDER') return q.targetsFieldKeys.every((k) => held.has(`${q.elementId}\u0000${k}`));
        if (g?.generator === 'CONTINUITY') {
            if (!g.continuityRef || !openBases.has(g.continuityRef)) return false;
            // A gap asks for an empty story time: still empty, and no check answers it (rule 5).
            return !g.continuityRef.startsWith('gap:') || q.targetsFieldKeys.every((k) => !values.has(k) && !answeredByCheck.has(`${q.elementId}\u0000${k}`));
        }
        if (q.mode === 'CHALLENGE') {
            const value = values.get(q.targetsFieldKeys[0]);
            return value !== undefined && q.challengeQuote !== null && isVerbatimQuote(q.challengeQuote, value);
        }
        return q.targetsFieldKeys.every((k) => !values.has(k) && !answeredByCheck.has(`${q.elementId}\u0000${k}`));
    });
}

/** Relations read to tell whether a pair has been related since its question was planned. */
const PAIR_PERSIST_RELATIONS_READ = 500;

/** Which continuity bases still stand: a pending contradiction, an open thread, a gap (always: its field is checked). */
async function openContinuityBases(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, refs: readonly string[]): Promise<Set<string>> {
    const ids = (prefix: string) => refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
    const out = new Set(refs.filter((r) => r.startsWith('gap:')));
    const proposals = ids('proposal:');
    if (proposals.length > 0) for (const p of await FactProposalRepository.pendingAmong(db, ctx.workspaceId, bookId, proposals)) out.add(`proposal:${p}`);
    const threads = ids('thread:');
    if (threads.length > 0) for (const t of await StoryThreadRepository.openAmong(db, ctx.workspaceId, bookId, threads)) out.add(`thread:${t}`);
    return out;
}

/**
 * THE HARD REPETITION GATE (Phase 4.4, D23: the repetition metric is a hard gate). Under the session's lock and the
 * book's question lock, drop every question whose (subject, keyed dedupe key) the book already holds, and every one the
 * round holds twice. Unlike `exactRepeatsOrNone` this read is not allowed to fail open: a failure fails the persist.
 */
async function withoutRepeats(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    questions: readonly PlannedQuestion[],
    textCtx: { elementNames: ReadonlyMap<string, string> },
    relationIds: ReadonlySet<string>,
): Promise<PlannedQuestion[]> {
    const keyed = questions.map((q) => {
        const dedupeKey = questionDedupeKey(dedupeTokens(sanitiseQuestionForStorage(q), textCtx));
        return { q, dedupeKey, key: exactKey(q.elementId, dedupeKey) };
    });
    const probes = keyed.filter((k) => k.q.elementId !== PENDING_SUBJECT_ID).map(({ q, dedupeKey }) => repeatProbe(q.elementId, dedupeKey, relationIds));
    const held = new Set((await QuestionRepository.findExactRepeats(db, ctx.workspaceId, session.bookId, probes)).map((r) => exactKey(r.elementId, r.dedupeKey)));
    const seen = new Set<string>();
    return keyed.filter(({ key }) => {
        if (held.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(({ q }) => q);
}

/** A subject's probe for the book's exact-repeat index: a relation names its relation, a pair its two elements. */
function repeatProbe(subjectId: string, dedupeKey: string, relationIds: ReadonlySet<string>) {
    const pair = pairOfSubject(subjectId);
    if (pair) return { elementId: pair.firstElementId, pairElementId: pair.secondElementId, dedupeKey };
    return { elementId: subjectId, dedupeKey, relation: relationIds.has(subjectId) };
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
        // Phase 4.4: a pair's names its two elements.
        const asked = probes
            .filter((p) => p.elementId !== PENDING_SUBJECT_ID)
            .map((p) => {
                const pair = pairOfSubject(p.elementId);
                return pair ? { elementId: pair.firstElementId, pairElementId: pair.secondElementId, dedupeKey: p.dedupeKey } : { ...p, relation: relationIds.has(p.elementId) };
            });
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
