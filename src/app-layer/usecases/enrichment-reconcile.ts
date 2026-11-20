/**
 * Enrichment's reconcile step (Phase 2.5): when a round closes, propose the
 * bible changes its answers support.
 *
 * WHEN. A round's run starts when it CLOSES: `closeRoundAndReconcile` (the
 * close route) closes the round (`closeRound`, 2.2) and then reconciles it in
 * the same request, after the close has committed; `stopInterviewAndReconcile`
 * (the stop route) does the same for the round a stop closes. The author can
 * re-run a FAILED or REFUSED run (`reconcileRound`, POST …/rounds/:n/reconcile).
 * Inline rather than a background job: the author is on the interview page
 * when the round closes and the proposals are what they review next, a
 * question round is generated inline the same way (2.2), and a failure is a
 * named, re-runnable state, never a lost job. A run that fails never undoes
 * the close: the answers are already saved (design 10.2).
 *
 * THE RUN, under 2.2's claim pattern, with the model call outside every
 * transaction:
 *
 *   1. CLAIM (the session's advisory lock): the round must be CLOSED; its run
 *      is created RUNNING, or a FAILED / REFUSED / stale RUNNING one is claimed
 *      again (one more attempt). A DONE run is never run again. When no call
 *      can be made — the deployment's configuration (no key, …), or the
 *      reconcile prompt has no evaluation record this deployment accepts
 *      (D11, `record-gate.ts`) — the run ends REFUSED here, with the reason,
 *      and nothing is sent. The round's input is read here: its questions,
 *      their latest answers, the scope elements' stored values, the book's
 *      elements.
 *   2. CALL (no transaction): `runReconcileStep` — one call through the
 *      reconciler; a failure is a named outcome (the table in
 *      `src/lib/enrichment/model-seam.ts`) and proposes nothing.
 *   3. PERSIST (the lock again): if this claim still holds the run, the
 *      output is validated AGAIN against the bible as it now stands (a field
 *      the author filled while the model worked refuses its ADD), new elements
 *      against the book's elements and its pending proposals, and every
 *      surviving proposal is stored — sanitised once more, encrypted, with its
 *      citations and the element's current version as its base. The run ends
 *      DONE (or FAILED with the outcome), the tokens are charged to the
 *      session, and the run is audited (counts and codes only).
 *
 * NOTHING HERE WRITES THE BIBLE: proposals wait for the author
 * (`enrichment-review.ts`). This module does not import the bible's writers,
 * so the dial guard (`dials-stay-off-the-bible-write-path`) does not count it
 * among the write path's roots, and it may read the deployment's D11 mode.
 *
 * Permissions: `bible.edit`, as the interview itself (a model call has no
 * permission of its own).
 */
import type { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleFieldRepository, BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import { EnrichmentProposalRepository, ReconcileRunRepository, type ReconcileRunRow } from '@/app-layer/repositories/enrichment.repository';
import { AnswerRepository, InterviewRoundRepository, InterviewSessionRepository, QuestionRepository, type AnswerRow, type RoundRow, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { RoundNumberParam } from '@/app-layer/schemas/interview';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import { AiUnavailableError, type AiUnavailableReason } from '@/lib/ai/errors';
import { decodeFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { BibleKind } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import { defaultReconciler } from '@/lib/enrichment/model-seam';
import { BOOK_ELEMENTS_IN_PROMPT_MAX, RECONCILE_PROMPT_VERSION } from '@/lib/enrichment/prompt';
import { runReconcileStep, validateOutput, type ReconcileMetrics, type ReconcileRoundInput, type RoundAnswerInput } from '@/lib/enrichment/reconcile';
import type { Reconciler } from '@/lib/enrichment/reconciler';
import { reconcileGate, type ReconcileGateVerdict } from '@/lib/enrichment/record-gate';
import { sanitiseProposalForStorage } from '@/lib/enrichment/storage';
import { nameKey } from '@/lib/enrichment/validate';
import { statusOfOutcome, type ReconcileOutcome, type RefusalCode } from '@/lib/enrichment/vocabulary';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { decodeOptions, decodeScaleLabels } from '@/lib/interview/storage';
import { logger } from '@/lib/observability/logger';
import { requireBook } from './bible-common';
import { deploymentPackRecordMode } from './interview-packs';
import { closeRound, stopInterview } from './interviews';
import type { InterviewView } from './interview-state';

/** What a usecase may be handed instead of the deployment's own (tests; the evaluation). */
export interface EnrichmentDeps {
    reconciler?: Reconciler;
    /** Which evaluation records count (D11); omitted: the deployment's. */
    recordMode?: PackRecordMode;
    /** The gate's verdict (tests); omitted: the committed record under the mode. */
    gate?: () => Promise<ReconcileGateVerdict>;
}

/** A RUNNING run older than this is a claim whose process died: the next request may run it again. */
export const STALE_RECONCILE_MS = 5 * 60_000;
/** A round's questions read at most (a round asks at most eight; rephrases add a few). */
const ROUND_QUESTIONS_MAX = 60;
/** A session's answer rows read at most (every revision). */
const SESSION_ANSWERS_READ = 2_000;
/** Stored fields read per element. */
const FIELDS_PER_ELEMENT = 50;
/** Pending new-element names compared at persist. */
const PENDING_NAMES_MAX = 500;

export interface ReconcileRunView {
    roundNumber: number;
    status: ReconcileRunRow['status'];
    outcome: ReconcileOutcome | null;
    attempts: number;
    /** Proposals stored, by kind (counts only). */
    proposed: { ADD: number; UPDATE: number; REMOVE: number; NEW_ELEMENT: number };
    noChange: number;
    /** Proposals code refused, by code (counts only). */
    refused: Partial<Record<RefusalCode, number>>;
    /** The guard flagged an answer of the round (the call went on, fenced). */
    reviewRequired: boolean;
    /** Why a REFUSED run was refused: 2.1's reason or the gate's. */
    refusalReason: string | null;
    finishedAt: string | null;
}

interface StoredMetrics extends Partial<ReconcileMetrics> {
    refusalReason?: string;
}

export function runView(run: ReconcileRunRow, roundNumber: number): ReconcileRunView {
    const m = (run.metrics ?? {}) as StoredMetrics;
    return {
        roundNumber,
        status: run.status,
        outcome: (run.outcome as ReconcileOutcome | null) ?? null,
        attempts: run.attempts,
        proposed: m.proposed ?? { ADD: 0, UPDATE: 0, REMOVE: 0, NEW_ELEMENT: 0 },
        noChange: m.noChange ?? 0,
        refused: m.refused ?? {},
        reviewRequired: m.reviewRequired ?? false,
        refusalReason: m.refusalReason ?? null,
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    };
}

/** The latest revision of each question's answer. */
function latestByQuestion(rows: readonly AnswerRow[]): Map<string, AnswerRow> {
    const out = new Map<string, AnswerRow>();
    for (const r of rows) {
        const prev = out.get(r.questionId);
        if (!prev || prev.revision < r.revision) out.set(r.questionId, r);
    }
    return out;
}

/** The scope elements' stored values, decoded, by element then key. */
async function storedValuesOf(db: PrismaTx, ctx: WorkspaceRequestContext, elementIds: readonly string[]): Promise<Map<string, Map<string, FieldValue>>> {
    const rows = await BibleFieldRepository.listForElements(db, ctx.workspaceId, elementIds, FIELDS_PER_ELEMENT);
    const out = new Map<string, Map<string, FieldValue>>(elementIds.map((id) => [id, new Map()]));
    for (const r of rows) out.get(r.elementId)?.set(r.key, decodeFieldValue(r.value));
    return out;
}

/**
 * The round as reconcile reads it: its questions' elements (those still in
 * the book) with their stored values and the keys the questions targeted, the
 * latest answer of each question, and the book's elements by kind and name.
 */
export async function loadRoundInput(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, round: RoundRow): Promise<ReconcileRoundInput> {
    const questions = await QuestionRepository.listForRound(db, ctx.workspaceId, session.id, round.id, ROUND_QUESTIONS_MAX);
    const latest = latestByQuestion(await AnswerRepository.listForSession(db, ctx.workspaceId, session.id, SESSION_ANSWERS_READ));
    const elementIds = [...new Set(questions.map((q) => q.elementId))];
    const rows = await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, elementIds);
    const stored = await storedValuesOf(db, ctx, rows.map((r) => r.id));
    const elements = rows.map((e) => {
        const targeted = new Set(questions.filter((q) => q.elementId === e.id).flatMap((q) => q.targetsFieldKeys));
        return {
            elementId: e.id,
            kind: e.kind as BibleKind,
            name: e.name,
            customLabel: e.customLabel,
            stored: stored.get(e.id) ?? new Map<string, FieldValue>(),
            scopeKeys: getTemplate(e.kind).fields.filter((f) => targeted.has(f.key)).map((f) => f.key),
        };
    });
    const live = new Set(rows.map((r) => r.id));
    const answers: RoundAnswerInput[] = [];
    for (const q of questions) {
        const a = latest.get(q.id);
        if (!a || !live.has(q.elementId)) continue;
        answers.push({
            answerId: a.id,
            elementId: q.elementId,
            targetsFieldKeys: q.targetsFieldKeys,
            questionKind: q.kind,
            question: q.text,
            options: decodeOptions(q.options),
            scaleLabels: decodeScaleLabels(q.scaleLabels),
            status: a.status,
            text: a.text,
            choice: a.choice,
            scale: a.scale,
        });
    }
    const book = await BibleElementRepository.page(db, ctx.workspaceId, session.bookId, { take: BOOK_ELEMENTS_IN_PROMPT_MAX });
    return { bookId: session.bookId, elements, answers, bookElements: book.map((b) => ({ kind: b.kind as BibleKind, name: b.name })) };
}

type Claim =
    | { kind: 'claimed'; runId: string; attempt: number; input: ReconcileRoundInput }
    | { kind: 'ended'; run: ReconcileRunRow }
    | { kind: 'skipped'; run: ReconcileRunRow };

async function finishRun(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, round: RoundRow, runId: string, attempt: number, outcome: ReconcileOutcome, metrics: StoredMetrics): Promise<boolean> {
    const ok = await ReconcileRunRepository.finish(db, ctx.workspaceId, runId, attempt, {
        status: statusOfOutcome(outcome),
        outcome,
        metrics: metrics as unknown as Prisma.InputJsonValue,
    });
    if (ok) {
        await logEvent(
            ctx,
            {
                action: 'ENRICHMENT_RECONCILED',
                entityType: 'InterviewRound',
                entityId: round.id,
                details: {
                    sessionId: session.id,
                    roundNumber: round.number,
                    outcome,
                    attempt,
                    proposed: metrics.proposed ?? null,
                    refused: metrics.refused ?? {},
                    promptVersion: RECONCILE_PROMPT_VERSION,
                    ...(metrics.aiCallId ? { aiCallId: metrics.aiCallId } : {}),
                },
            },
            { db },
        );
    }
    return ok;
}

async function claimRun(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    round: RoundRow,
    mode: 'auto' | 'explicit',
    refusal: { reason: string; outcome: 'AI_UNAVAILABLE' | 'RECONCILE_NOT_EVALUATED' } | null,
): Promise<Claim> {
    if (round.status !== 'CLOSED') throw new ConflictError('Only a closed round is reconciled.', { reason: 'ROUND_NOT_CLOSED', status: round.status });
    const existing = await ReconcileRunRepository.find(db, ctx.workspaceId, session.id, round.id);
    let runId: string;
    let attempt: number;
    if (existing) {
        const fresh = existing.status === 'RUNNING' && Date.now() - existing.startedAt.getTime() < STALE_RECONCILE_MS;
        if (existing.status === 'DONE' || fresh) {
            if (mode === 'auto') return { kind: 'skipped', run: existing };
            throw new ConflictError(fresh ? 'This round is being reconciled.' : 'This round has been reconciled.', { reason: fresh ? 'RECONCILE_RUNNING' : 'RECONCILE_DONE' });
        }
        attempt = existing.attempts + 1;
        runId = existing.id;
        await ReconcileRunRepository.reclaim(db, ctx.workspaceId, runId, RECONCILE_PROMPT_VERSION, attempt);
    } else {
        const created = await ReconcileRunRepository.create(db, ctx.workspaceId, { bookId: session.bookId, sessionId: session.id, roundId: round.id, promptVersion: RECONCILE_PROMPT_VERSION });
        runId = created.id;
        attempt = created.attempts;
    }
    if (refusal) {
        await finishRun(db, ctx, session, round, runId, attempt, refusal.outcome, { refusalReason: refusal.reason });
        return { kind: 'ended', run: (await ReconcileRunRepository.find(db, ctx.workspaceId, session.id, round.id))! };
    }
    return { kind: 'claimed', runId, attempt, input: await loadRoundInput(db, ctx, session, round) };
}

/** Store what survived validation against the bible as it stands now, and end the run. */
async function persistRun(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    session: SessionRow,
    round: RoundRow,
    claim: Extract<Claim, { kind: 'claimed' }>,
    step: Awaited<ReturnType<typeof runReconcileStep>>,
): Promise<void> {
    const run = await ReconcileRunRepository.find(db, ctx.workspaceId, session.id, round.id);
    // A claim overtaken (stale, and claimed again by another request): this call's answer is not used.
    if (!run || run.status !== 'RUNNING' || run.attempts !== claim.attempt) return;
    if (step.metrics.tokensUsed > 0) await InterviewSessionRepository.addTokens(db, ctx.workspaceId, session.id, step.metrics.tokensUsed);
    if (step.outcome !== 'OK' || !step.call) {
        await finishRun(db, ctx, session, round, claim.runId, claim.attempt, step.outcome, step.metrics);
        return;
    }
    // Validate again against the bible as it stands under the lock: no lock
    // was held while the model worked, so a field may have been filled or an
    // element deleted meanwhile.
    const now = await loadRoundInput(db, ctx, session, round);
    const validation = validateOutput(step.call.output, now);
    const pendingNames = new Set(
        (await EnrichmentProposalRepository.pendingNewElementNames(db, ctx.workspaceId, session.bookId, PENDING_NAMES_MAX)).map((p) => nameKey(p.newName ?? '')),
    );
    const kinds = new Map(now.elements.map((e) => [e.elementId, e.kind]));
    const versions = new Map<string, number>();
    const proposed = { ADD: 0, UPDATE: 0, REMOVE: 0, NEW_ELEMENT: 0 };
    const refused: Partial<Record<RefusalCode, number>> = {};
    for (const r of validation.refusals) refused[r.code] = (refused[r.code] ?? 0) + 1;
    for (const draft of validation.proposals) {
        if (draft.kind === 'NEW_ELEMENT') {
            const key = nameKey(draft.name);
            const named = await BibleElementRepository.page(db, ctx.workspaceId, session.bookId, { q: draft.name, take: 20 });
            if (pendingNames.has(key) || named.some((e) => nameKey(e.name) === key)) {
                const code: RefusalCode = pendingNames.has(key) ? 'ALREADY_PROPOSED' : 'ELEMENT_EXISTS';
                refused[code] = (refused[code] ?? 0) + 1;
                continue;
            }
            pendingNames.add(key);
        }
        const elementKind = draft.kind === 'FIELD' ? (kinds.get(draft.elementId) ?? null) : null;
        const text = sanitiseProposalForStorage(draft, elementKind);
        let baseVersion: number | null = null;
        if (draft.kind === 'FIELD') {
            if (!versions.has(draft.elementId)) versions.set(draft.elementId, await BibleVersionRepository.latestNumber(db, ctx.workspaceId, draft.elementId));
            baseVersion = versions.get(draft.elementId)!;
        }
        await EnrichmentProposalRepository.create(
            db,
            ctx.workspaceId,
            {
                bookId: session.bookId,
                sessionId: session.id,
                roundId: round.id,
                kind: draft.kind,
                elementId: draft.kind === 'FIELD' ? draft.elementId : null,
                fieldKey: draft.kind === 'FIELD' ? draft.fieldKey : null,
                operation: draft.kind === 'FIELD' ? draft.operation : null,
                proposedValue: text.proposedValue,
                baseVersion,
                newKind: draft.kind === 'NEW_ELEMENT' ? draft.newKind : null,
                newName: text.newName,
                newSummary: text.newSummary,
            },
            draft.citedAnswerIds,
        );
        if (draft.kind === 'NEW_ELEMENT') proposed.NEW_ELEMENT++;
        else proposed[draft.operation]++;
    }
    await finishRun(db, ctx, session, round, claim.runId, claim.attempt, 'OK', {
        ...step.metrics,
        proposed,
        noChange: validation.noChange,
        refused,
        unreadable: validation.unreadable,
    });
}

/** Why no call can be made before anything is claimed: 2.1's configuration, then the D11 gate. */
async function refusalOf(reconciler: Reconciler, deps: EnrichmentDeps): Promise<{ reason: string; outcome: 'AI_UNAVAILABLE' | 'RECONCILE_NOT_EVALUATED' } | null> {
    const unavailable = reconciler.unavailableReason();
    if (unavailable) return { reason: unavailable, outcome: 'AI_UNAVAILABLE' };
    const verdict = await (deps.gate ? deps.gate() : reconcileGate(deps.recordMode ?? deploymentPackRecordMode()));
    if (!verdict.mounted) return { reason: verdict.reason, outcome: 'RECONCILE_NOT_EVALUATED' };
    return null;
}

/** Reconcile one CLOSED round of the session (the order in the header). Returns its run. */
async function reconcileClosedRound(
    ctx: WorkspaceRequestContext,
    bookId: string,
    sessionId: string,
    roundNumber: number,
    mode: 'auto' | 'explicit',
    deps: EnrichmentDeps,
): Promise<ReconcileRunView> {
    const reconciler = deps.reconciler ?? defaultReconciler(ctx);
    const refusal = await refusalOf(reconciler, deps);

    const claimed = await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await InterviewSessionRepository.lock(db, sessionId);
        const session = await InterviewSessionRepository.find(db, ctx.workspaceId, bookId, sessionId);
        if (!session) throw new NotFoundError('Interview not found.');
        const round = await InterviewRoundRepository.findByNumber(db, ctx.workspaceId, sessionId, roundNumber);
        if (!round) throw new NotFoundError('Round not found.');
        // An explicit run that cannot call the model refuses before it writes (2.1's rule); an automatic one records why.
        if (mode === 'explicit' && refusal?.outcome === 'AI_UNAVAILABLE') throw new AiUnavailableError(refusal.reason as AiUnavailableReason);
        return { session, round, claim: await claimRun(db, ctx, session, round, mode, refusal) };
    });
    const { session, round, claim } = claimed;
    if (claim.kind !== 'claimed') return runView(claim.run, round.number);

    let step: Awaited<ReturnType<typeof runReconcileStep>>;
    try {
        step = await runReconcileStep(claim.input, reconciler);
    } catch (err) {
        // Not a model condition (each of those is a named outcome): a bug. The
        // run is ended FAILED rather than left RUNNING until it goes stale.
        logger.error('enrichment.reconcile_failed', { component: 'enrichment', sessionId, roundNumber, error: err instanceof Error ? err.name : 'unknown' });
        await runInWorkspaceContext(ctx, async (db) => {
            await InterviewSessionRepository.lock(db, sessionId);
            await finishRun(db, ctx, session, round, claim.runId, claim.attempt, 'PROVIDER_FAILURE', { refusalReason: 'INTERNAL_ERROR' });
        });
        throw err;
    }
    return runInWorkspaceContext(ctx, async (db) => {
        await InterviewSessionRepository.lock(db, sessionId);
        await persistRun(db, ctx, session, round, claim, step);
        const run = await ReconcileRunRepository.find(db, ctx.workspaceId, sessionId, round.id);
        return runView(run!, round.number);
    });
}

/** Run (or re-run) the reconcile step of a closed round: POST …/rounds/:n/reconcile. A DONE run is a 409. */
export async function reconcileRound(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, roundNumberParam: string, deps: EnrichmentDeps = {}): Promise<ReconcileRunView> {
    await assertPermission(ctx, 'bible.edit');
    return reconcileClosedRound(ctx, bookId, sessionId, RoundNumberParam.parse(roundNumberParam), 'explicit', deps);
}

/** The automatic run after a close: never fails the close, whatever happens to it. */
async function reconcileAfterClose(ctx: WorkspaceRequestContext, bookId: string, sessionId: string, roundNumber: number, deps: EnrichmentDeps): Promise<ReconcileRunView | null> {
    try {
        return await reconcileClosedRound(ctx, bookId, sessionId, roundNumber, 'auto', deps);
    } catch (err) {
        logger.warn('enrichment.reconcile_after_close_failed', { component: 'enrichment', sessionId, roundNumber, error: err instanceof Error ? err.name : 'unknown' });
        return null;
    }
}

/**
 * Close a round (2.2's `closeRound`: every question has a status, the session
 * may end) and then reconcile it. The close commits first; the reconcile's
 * outcome, whatever it is, is reported beside the interview and never undoes it.
 */
export async function closeRoundAndReconcile(
    ctx: WorkspaceRequestContext,
    bookId: string,
    sessionId: string,
    roundNumberParam: string,
    input: unknown,
    deps: EnrichmentDeps = {},
): Promise<{ interview: InterviewView; reconcile: ReconcileRunView | null }> {
    const interview = await closeRound(ctx, bookId, sessionId, roundNumberParam, input);
    const reconcile = await reconcileAfterClose(ctx, bookId, sessionId, RoundNumberParam.parse(roundNumberParam), deps);
    return { interview, reconcile };
}

/** Rounds a stop is checked for at most (the open one it closes is the newest). */
const STOP_ROUNDS_READ = 50;

/**
 * Stop an interview (2.2's `stopInterview`: what was answered is kept) and
 * reconcile every closed round of it that has no run yet — normally the open
 * round the stop just closed (design 10.1: "kept and reconciled").
 */
export async function stopInterviewAndReconcile(
    ctx: WorkspaceRequestContext,
    bookId: string,
    sessionId: string,
    deps: EnrichmentDeps = {},
): Promise<{ interview: InterviewView; reconcile: ReconcileRunView[] }> {
    const interview = await stopInterview(ctx, bookId, sessionId);
    const pending = await runInWorkspaceContext(ctx, async (db) => {
        const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, STOP_ROUNDS_READ);
        const runs = await ReconcileRunRepository.listForSession(db, ctx.workspaceId, sessionId, STOP_ROUNDS_READ);
        const ran = new Set(runs.map((r) => r.roundId));
        return rounds.filter((r) => r.status === 'CLOSED' && !ran.has(r.id)).map((r) => r.number);
    });
    const reconcile: ReconcileRunView[] = [];
    for (const n of pending) {
        const view = await reconcileAfterClose(ctx, bookId, sessionId, n, deps);
        if (view) reconcile.push(view);
    }
    return { interview, reconcile };
}
