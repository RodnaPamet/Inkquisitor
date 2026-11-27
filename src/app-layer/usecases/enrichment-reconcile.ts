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
import {
    BibleElementRepository,
    BibleFieldRepository,
    BibleRelationFieldRepository,
    BibleRelationRepository,
    BibleRelationVersionRepository,
    BibleVersionRepository,
} from '@/app-layer/repositories/bible.repository';
import { EnrichmentProposalRepository, ReconcileRunRepository, type ReconcileRunRow } from '@/app-layer/repositories/enrichment.repository';
import { AnswerRepository, InterviewRoundRepository, InterviewSessionRepository, QuestionRepository, type AnswerRow, type RoundRow, type SessionRow } from '@/app-layer/repositories/interview.repository';
import { RoundNumberParam } from '@/app-layer/schemas/interview';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import { AiUnavailableError, type AiUnavailableReason } from '@/lib/ai/errors';
import { decodeFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { BibleKind } from '@/lib/bible/kinds';
import { getRelationType, getTemplate, relationFieldDefs } from '@/lib/bible/templates';
import { slotBeat } from './story-slot';
import { pairOfSubject, PENDING_SUBJECT_ID, relationSubjectName, sceneSubjectId, subjectIdOf, type RelationSubject } from '@/lib/interview/subjects';
import { SCENE_CARD_FIELD_KEYS, SCENE_CARD_FIELDS } from '@/lib/manuscript/scene-card';
import { SceneCardRepository } from '@/app-layer/repositories/scene-card.repository';
import { defaultReconciler } from '@/lib/enrichment/model-seam';
import { BOOK_ELEMENTS_IN_PROMPT_MAX, RECONCILE_PROMPT_VERSION } from '@/lib/enrichment/prompt';
import { emptyProposedCounts, runReconcileStep, validateOutput, type ProposedCounts, type ReconcileMetrics, type ReconcileRoundInput, type RoundAnswerInput, type RoundElementInput } from '@/lib/enrichment/reconcile';
import type { Reconciler } from '@/lib/enrichment/reconciler';
import { reconcileGate, type ReconcileGateVerdict } from '@/lib/enrichment/record-gate';
import { sanitiseProposalForStorage } from '@/lib/enrichment/storage';
import { nameKey, type RelationEnd } from '@/lib/enrichment/validate';
import { effectiveRunState, STALE_RECONCILE_MS, statusOfOutcome, type ReconcileOutcome, type RefusalCode } from '@/lib/enrichment/vocabulary';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { decodeOptions, decodeScaleLabels } from '@/lib/interview/storage';
import { TOKENS_PER_RECONCILE_CALL } from '@/lib/interview/dials';
import { logger } from '@/lib/observability/logger';
import { requireBook } from './bible-common';
import { bookHoldsElementName } from './enrichment-names';
import { deploymentPackRecordMode } from './interview-packs';
import { closeRound, stopInterview } from './interviews';
import { SESSION_ANSWERS_MAX, type InterviewView } from './interview-state';

/** What a usecase may be handed instead of the deployment's own (tests; the evaluation). */
export interface EnrichmentDeps {
    reconciler?: Reconciler;
    /** Which evaluation records count (D11); omitted: the deployment's. */
    recordMode?: PackRecordMode;
    /** The gate's verdict (tests); omitted: the committed record under the mode. */
    gate?: () => Promise<ReconcileGateVerdict>;
}

/** A RUNNING run older than this is a claim whose process died: the next request may run it again (`vocabulary.ts`). */
export { STALE_RECONCILE_MS };
/** A round's questions read at most (a round asks at most eight; rephrases add a few). */
const ROUND_QUESTIONS_MAX = 60;
/** A session's answer rows read at most (every revision): the session state's own bound, which `session-bounds.test.ts` holds to every row a session can have. */
const SESSION_ANSWERS_READ = SESSION_ANSWERS_MAX;
/** Stored fields read per element. */
const FIELDS_PER_ELEMENT = 50;
/** Pending new-element names compared at persist. */
const PENDING_NAMES_MAX = 500;

export interface ReconcileRunView {
    roundNumber: number;
    status: ReconcileRunRow['status'];
    outcome: ReconcileOutcome | null;
    attempts: number;
    /** Proposals stored, by kind (counts only; a relation's field among ADD, UPDATE and REMOVE). */
    proposed: ProposedCounts;
    /** Of those, flagged POSSIBLE_INSTRUCTION for the author (D14). */
    flagged: number;
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
    const state = effectiveRunState(run);
    return {
        roundNumber,
        status: state.status,
        outcome: state.outcome,
        attempts: run.attempts,
        proposed: { ...emptyProposedCounts(), ...(m.proposed ?? {}) },
        flagged: m.flagged ?? 0,
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

/** Relations read as the ends of a new relation's existing pairs, at most. */
const EXISTING_RELATIONS_READ = 500;
/** Stored relation fields read per relation. */
const FIELDS_PER_RELATION = 10;

/**
 * The elements a new relation may join, by the session's scope (Phase 3.3,
 * D24): a SELECTION's elements and its relations' ends; a BETWEEN session's
 * two neighbours (an answer about the slot addresses them). Every other scope
 * offers none, so it proposes no relation.
 */
async function relationEndsOf(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow): Promise<RelationEnd[]> {
    if (session.scope === 'SELECTION') {
        const relations = await BibleRelationRepository.listByIdsWithEnds(db, ctx.workspaceId, session.bookId, session.scopeRelationIds);
        const ids = [...new Set([...session.scopeElementIds, ...relations.flatMap((r) => [r.fromElementId, r.toElementId])])];
        const rows = await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, ids);
        return rows.map((e) => ({ elementId: e.id, kind: e.kind as BibleKind, name: e.name }));
    }
    if (session.scope === 'BETWEEN' && session.slotAfterElementId && session.slotBeforeElementId) {
        const rows = await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, [session.slotAfterElementId, session.slotBeforeElementId]);
        return rows.map((e) => ({ elementId: e.id, kind: e.kind as BibleKind, name: e.name, neighbour: true }));
    }
    return [];
}

/**
 * The round as reconcile reads it: its questions' SUBJECTS (Phase 3.3:
 * elements, relations and the BETWEEN slot's element not yet created, those
 * still in the book) with their stored values and the keys the questions
 * targeted, the latest answer of each question, the book's elements by kind
 * and name, and the ends a new relation may join with the relations the book
 * holds between them.
 */
export async function loadRoundInput(db: PrismaTx, ctx: WorkspaceRequestContext, session: SessionRow, round: RoundRow): Promise<ReconcileRoundInput> {
    // Phase 4.4 (D30, item 2): a SOURCE question decides its fact (when the round closes) and fills no field: reconcile
    // never reads it, so a "yes" is never turned into a field value.
    const questions = (await QuestionRepository.listForRound(db, ctx.workspaceId, session.id, round.id, ROUND_QUESTIONS_MAX)).filter((q) => q.generator !== 'SOURCES');
    const latest = latestByQuestion(await AnswerRepository.listForSession(db, ctx.workspaceId, session.id, SESSION_ANSWERS_READ));
    const targetedOf = (subject: string) => new Set(questions.filter((q) => subjectIdOf(q) === subject).flatMap((q) => q.targetsFieldKeys));

    const elementIds = [...new Set(questions.filter((q) => !q.relationId && !q.aboutPending && !q.pairElementId && !q.sceneId).map((q) => q.elementId))];
    const rows = await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, elementIds);
    const stored = await storedValuesOf(db, ctx, rows.map((r) => r.id));
    const elements: RoundElementInput[] = rows.map((e) => {
        const targeted = targetedOf(e.id);
        return {
            elementId: e.id,
            kind: e.kind as BibleKind,
            name: e.name,
            customLabel: e.customLabel,
            stored: stored.get(e.id) ?? new Map<string, FieldValue>(),
            scopeKeys: getTemplate(e.kind).fields.filter((f) => targeted.has(f.key)).map((f) => f.key),
        };
    });

    // The relations the round asked about (Phase 3.3), with their stored fields.
    const relationIds = [...new Set(questions.flatMap((q) => (q.relationId ? [q.relationId] : [])))];
    const relations = await BibleRelationRepository.listByIdsWithEnds(db, ctx.workspaceId, session.bookId, relationIds);
    const relationStored = new Map<string, Map<string, FieldValue>>(relations.map((r) => [r.id, new Map()]));
    for (const f of await BibleRelationFieldRepository.listForRelations(db, ctx.workspaceId, relations.map((r) => r.id), FIELDS_PER_RELATION)) {
        relationStored.get(f.relationId)?.set(f.key, decodeFieldValue(f.value));
    }
    for (const r of relations) {
        const relation: RelationSubject = {
            relationId: r.id,
            type: r.type,
            label: getRelationType(r.from.kind, r.type)?.label ?? r.type,
            fromElementId: r.fromElementId,
            toElementId: r.toElementId,
            fromKind: r.from.kind,
            toKind: r.to.kind,
            fromName: r.from.name,
            toName: r.to.name,
        };
        const targeted = targetedOf(r.id);
        elements.push({
            elementId: r.id,
            kind: r.from.kind,
            name: relationSubjectName(relation),
            customLabel: null,
            stored: relationStored.get(r.id) ?? new Map(),
            scopeKeys: relationFieldDefs(r.from.kind, r.type).filter((f) => targeted.has(f.key)).map((f) => f.key),
            relation,
        });
    }

    // Phase 5.3: the scenes whose CARD the round asked about (a SCENE session's one scene), with the card's stored
    // fields. A card field is a proposal like any other; only `scene-card.ts` writes it once accepted (never the prose).
    const sceneIds = [...new Set(questions.flatMap((q) => (q.sceneId ? [q.sceneId] : [])))];
    for (const sceneId of sceneIds) {
        const scene = await SceneCardRepository.sceneForInterview(db, ctx.workspaceId, session.bookId, sceneId);
        if (!scene) continue;
        const card = await SceneCardRepository.find(db, ctx.workspaceId, session.bookId, sceneId);
        const cardStored = new Map<string, FieldValue>();
        for (const key of SCENE_CARD_FIELD_KEYS) {
            const value = card?.[key];
            if (typeof value === 'string' && value !== '') cardStored.set(key, value);
        }
        const subject = sceneSubjectId(sceneId);
        const targeted = targetedOf(subject);
        const carrier = questions.find((q) => q.sceneId === sceneId)!;
        const carrierKind = rows.find((r) => r.id === carrier.elementId)?.kind ?? (await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, [carrier.elementId]))[0]?.kind;
        if (!carrierKind) continue;
        elements.push({
            elementId: subject,
            kind: carrierKind as BibleKind,
            name: scene.title ?? 'Untitled scene',
            customLabel: null,
            stored: cardStored,
            scopeKeys: SCENE_CARD_FIELDS.filter((f) => targeted.has(f.key)).map((f) => f.key),
            scene: { sceneId },
        });
    }

    // The BETWEEN slot's element not yet created, when the round asked about it and both neighbours remain. A slot
    // that already holds its beat (a pending or accepted proposal, Phase 3.H) takes no second one (SLOT_TAKEN), and
    // the session goes on with it (D25 as amended): the subject carries the beat's name and what it already holds,
    // and its ADDs become field proposals for that beat (`targetProposalId`), waiting for it.
    const relationEnds = await relationEndsOf(db, ctx, session);
    let slot: ReconcileRoundInput['slot'] = null;
    if (session.scope === 'BETWEEN' && session.slotKind && relationEnds.length === 2) {
        const beat = await slotBeat(db, ctx, session);
        slot = { kind: session.slotKind as BibleKind, ...(beat ? { taken: true, beatProposalId: beat.proposalId } : {}) };
        if (questions.some((q) => q.aboutPending)) {
            const targeted = targetedOf(PENDING_SUBJECT_ID);
            const after = relationEnds.find((e) => e.elementId === session.slotAfterElementId)!;
            const before = relationEnds.find((e) => e.elementId === session.slotBeforeElementId)!;
            elements.push({
                elementId: PENDING_SUBJECT_ID,
                kind: slot.kind,
                name: beat && beat.name !== '' ? beat.name : `${after.name} → … → ${before.name}`,
                customLabel: null,
                stored: beat?.fields ?? new Map(),
                scopeKeys: getTemplate(slot.kind).fields.filter((f) => targeted.has(f.key)).map((f) => f.key),
                pending: { afterName: after.name, beforeName: before.name, ...(beat ? { proposedName: beat.name } : {}) },
            });
        }
    }

    // Phase 4.4 (D30, item 3): a PAIR question's two elements are relation ends (a NEW_RELATION between them may be
    // proposed from its answer), and the pair is a live subject while both elements stand. Its own fields are no
    // element's, so no field operation on it passes `validate.ts`'s rule 1.
    const pairSubjects = [...new Set(questions.filter((q) => q.pairElementId).map((q) => subjectIdOf(q)))];
    const pairIds = [...new Set(pairSubjects.flatMap((id) => {
        const p = pairOfSubject(id);
        return p ? [p.firstElementId, p.secondElementId] : [];
    }))].filter((id) => !relationEnds.some((e) => e.elementId === id));
    if (pairIds.length > 0) {
        for (const e of await BibleElementRepository.listByIds(db, ctx.workspaceId, session.bookId, pairIds)) relationEnds.push({ elementId: e.id, kind: e.kind as BibleKind, name: e.name });
    }
    const endIds = new Set(relationEnds.map((e) => e.elementId));
    const live = new Set([
        ...elements.map((e) => e.elementId),
        ...pairSubjects.filter((id) => {
            const p = pairOfSubject(id);
            return p !== null && endIds.has(p.firstElementId) && endIds.has(p.secondElementId);
        }),
    ]);
    const answers: RoundAnswerInput[] = [];
    for (const q of questions) {
        const a = latest.get(q.id);
        const subject = subjectIdOf(q);
        if (!a || !live.has(subject)) continue;
        answers.push({
            answerId: a.id,
            elementId: subject,
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
    const existing = await BibleRelationRepository.listBetween(db, ctx.workspaceId, session.bookId, relationEnds.map((e) => e.elementId), EXISTING_RELATIONS_READ);
    return {
        bookId: session.bookId,
        elements,
        answers,
        bookElements: book.map((b) => ({ kind: b.kind as BibleKind, name: b.name })),
        relationEnds,
        existingRelations: existing.map((r) => ({ fromElementId: r.fromElementId, toElementId: r.toElementId, type: r.type, symmetric: r.symmetric })),
        slot,
    };
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
        const fresh = existing.status === 'RUNNING' && effectiveRunState(existing).status === 'RUNNING';
        if (existing.status === 'DONE' || fresh) {
            if (mode === 'auto') return { kind: 'skipped', run: existing };
            throw new ConflictError(fresh ? 'This round is being reconciled.' : 'This round has been reconciled.', { reason: fresh ? 'RECONCILE_RUNNING' : 'RECONCILE_DONE' });
        }
        // A stale claim (its process died) is recorded as such before it is claimed again: the
        // expired attempt is audited CLAIM_EXPIRED, and a late answer of it is refused by its attempt.
        if (existing.status === 'RUNNING') await finishRun(db, ctx, session, round, existing.id, existing.attempts, 'CLAIM_EXPIRED', {});
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
    const input = await loadRoundInput(db, ctx, session, round);
    // The session's token budget (2.H item 2): a round with answers to
    // reconcile needs one call, and a session that cannot take it is REFUSED
    // TOKEN_BUDGET, nothing sent, its answers kept. A round with nothing
    // answered needs no call, so it still ends NOTHING_TO_RECONCILE.
    if (input.answers.some((a) => a.status === 'ANSWERED') && reconcileOverTokenBudget(session)) {
        await finishRun(db, ctx, session, round, runId, attempt, 'TOKEN_BUDGET', { refusalReason: 'TOKEN_BUDGET' });
        return { kind: 'ended', run: (await ReconcileRunRepository.find(db, ctx.workspaceId, session.id, round.id))! };
    }
    return { kind: 'claimed', runId, attempt, input };
}

/** Would one more reconcile call pass the session's token budget? (`TOKENS_PER_RECONCILE_CALL`, the share `tokenBudgetFor` gives each round.) */
export function reconcileOverTokenBudget(session: Pick<SessionRow, 'tokensUsed' | 'tokenBudget'>): boolean {
    return session.tokensUsed + TOKENS_PER_RECONCILE_CALL > session.tokenBudget;
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
    // The call's tokens are the session's whatever becomes of its answer (2.2's rule), an overtaken claim's too.
    if (step.metrics.tokensUsed > 0) await InterviewSessionRepository.addTokens(db, ctx.workspaceId, session.id, step.metrics.tokensUsed);
    const run = await ReconcileRunRepository.find(db, ctx.workspaceId, session.id, round.id);
    // A claim overtaken (stale, and claimed again by another request): this call's answer is not used.
    if (!run || run.status !== 'RUNNING' || run.attempts !== claim.attempt) return;
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
    const subjects = new Map(now.elements.map((e) => [e.elementId, e] as const));
    const ends = new Map((now.relationEnds ?? []).map((e) => [e.elementId, e] as const));
    const versions = new Map<string, number>();
    const relationVersions = new Map<string, number>();
    const cardVersions = new Map<string, number>();
    const proposed = emptyProposedCounts();
    let flagged = 0;
    const refused: Partial<Record<RefusalCode, number>> = {};
    const refuse = (code: RefusalCode) => {
        refused[code] = (refused[code] ?? 0) + 1;
    };
    for (const r of validation.refusals) refuse(r.code);
    // A new element's proposal id by its place among the output's new elements: what a new relation's `new.N` end names.
    const newElementProposals = new Map<number, string>();
    const newElementDrafts = new Map(validation.proposals.flatMap((p) => (p.kind === 'NEW_ELEMENT' ? [[p.outputIndex, p] as const] : [])));
    // New elements first, so a new relation's end is stored before it.
    const ordered = [...validation.proposals].sort((a, b) => (a.kind === 'NEW_RELATION' ? 1 : 0) - (b.kind === 'NEW_RELATION' ? 1 : 0));
    for (const draft of ordered) {
        if (draft.kind === 'NEW_ELEMENT') {
            const key = nameKey(draft.name);
            const alreadyProposed = pendingNames.has(key);
            if (alreadyProposed || (await bookHoldsElementName(db, ctx, session.bookId, draft.name))) {
                refuse(alreadyProposed ? 'ALREADY_PROPOSED' : 'ELEMENT_EXISTS');
                continue;
            }
            pendingNames.add(key);
            const text = sanitiseProposalForStorage(draft, draft.newKind);
            const row = await EnrichmentProposalRepository.create(
                db,
                ctx.workspaceId,
                {
                    bookId: session.bookId,
                    sessionId: session.id,
                    roundId: round.id,
                    kind: 'NEW_ELEMENT',
                    elementId: null,
                    fieldKey: null,
                    operation: null,
                    proposedValue: text.proposedValue,
                    baseVersion: null,
                    newKind: draft.newKind,
                    newName: text.newName,
                    newSummary: text.newSummary,
                    fillsSlot: draft.fillsSlot,
                    flags: [...draft.flags],
                },
                draft.citedAnswerIds,
            );
            newElementProposals.set(draft.outputIndex, row.id);
            proposed.NEW_ELEMENT++;
            if (draft.flags.length > 0) flagged++;
            continue;
        }
        if (draft.kind === 'NEW_RELATION') {
            // An end that is a new element of this answer must have been stored above (not a name the book now holds).
            const endOf = (r: typeof draft.from) => ('elementId' in r ? { elementId: r.elementId, proposalId: null } : { elementId: null, proposalId: newElementProposals.get(r.newElement) ?? null });
            const from = endOf(draft.from);
            const to = endOf(draft.to);
            if ((from.elementId === null && from.proposalId === null) || (to.elementId === null && to.proposalId === null)) {
                refuse('RELATION_END_REFUSED');
                continue;
            }
            const fromKind = 'elementId' in draft.from ? ends.get(draft.from.elementId)?.kind : newElementDrafts.get(draft.from.newElement)?.newKind;
            if (!fromKind) {
                refuse('RELATION_END_OUT_OF_SCOPE');
                continue;
            }
            const text = sanitiseProposalForStorage(draft, { relationType: draft.type, fromKind });
            await EnrichmentProposalRepository.create(
                db,
                ctx.workspaceId,
                {
                    bookId: session.bookId,
                    sessionId: session.id,
                    roundId: round.id,
                    kind: 'NEW_RELATION',
                    elementId: null,
                    fieldKey: null,
                    operation: null,
                    proposedValue: text.proposedValue,
                    baseVersion: null,
                    newKind: null,
                    newName: null,
                    newSummary: null,
                    newRelationType: draft.type,
                    newFromElementId: from.elementId,
                    newToElementId: to.elementId,
                    newFromProposalId: from.proposalId,
                    newToProposalId: to.proposalId,
                    flags: [...draft.flags],
                },
                draft.citedAnswerIds,
            );
            proposed.NEW_RELATION++;
            if (draft.flags.length > 0) flagged++;
            continue;
        }
        const subject = subjects.get(draft.elementId);
        if (!subject) continue;
        if (subject.scene) {
            // A scene card's field (Phase 5.3): based on the card's version (0: no card yet); never the scene's prose (D3).
            const sceneId = subject.scene.sceneId;
            if (!cardVersions.has(sceneId)) cardVersions.set(sceneId, (await SceneCardRepository.find(db, ctx.workspaceId, session.bookId, sceneId))?.version ?? 0);
            const text = sanitiseProposalForStorage(draft, { sceneCard: true });
            await EnrichmentProposalRepository.create(
                db,
                ctx.workspaceId,
                {
                    bookId: session.bookId,
                    sessionId: session.id,
                    roundId: round.id,
                    kind: 'SCENE_CARD_FIELD',
                    elementId: null,
                    sceneId,
                    fieldKey: draft.fieldKey,
                    operation: draft.operation,
                    proposedValue: text.proposedValue,
                    baseVersion: cardVersions.get(sceneId)!,
                    newKind: null,
                    newName: null,
                    newSummary: null,
                    flags: [...draft.flags],
                },
                draft.citedAnswerIds,
            );
        } else if (subject.relation) {
            // A relation's field (Phase 3.3): based on the relation's latest version (0: none yet).
            const relationId = subject.relation.relationId;
            if (!relationVersions.has(relationId)) relationVersions.set(relationId, await BibleRelationVersionRepository.latestNumber(db, ctx.workspaceId, relationId));
            const text = sanitiseProposalForStorage(draft, { relationType: subject.relation.type, fromKind: subject.relation.fromKind });
            await EnrichmentProposalRepository.create(
                db,
                ctx.workspaceId,
                {
                    bookId: session.bookId,
                    sessionId: session.id,
                    roundId: round.id,
                    kind: 'RELATION_FIELD',
                    elementId: null,
                    relationId,
                    fieldKey: draft.fieldKey,
                    operation: draft.operation,
                    proposedValue: text.proposedValue,
                    baseVersion: relationVersions.get(relationId)!,
                    newKind: null,
                    newName: null,
                    newSummary: null,
                    flags: [...draft.flags],
                },
                draft.citedAnswerIds,
            );
        } else if (draft.toSlotBeat) {
            // A further field of the slot's beat an earlier round proposed (Phase 3.H, D25 as amended): it names the
            // beat's proposal and waits for it, with no element and no base version yet; ADD only (the CHECK holds both).
            const beatProposalId = now.slot?.beatProposalId;
            if (!beatProposalId) {
                refuse('PENDING_WITHOUT_ELEMENT');
                continue;
            }
            const text = sanitiseProposalForStorage(draft, subject.kind);
            await EnrichmentProposalRepository.create(
                db,
                ctx.workspaceId,
                {
                    bookId: session.bookId,
                    sessionId: session.id,
                    roundId: round.id,
                    kind: 'FIELD',
                    elementId: null,
                    fieldKey: draft.fieldKey,
                    operation: draft.operation,
                    proposedValue: text.proposedValue,
                    baseVersion: null,
                    newKind: null,
                    newName: null,
                    newSummary: null,
                    targetProposalId: beatProposalId,
                    flags: [...draft.flags],
                },
                draft.citedAnswerIds,
            );
        } else {
            const text = sanitiseProposalForStorage(draft, subject.kind);
            if (!versions.has(draft.elementId)) versions.set(draft.elementId, await BibleVersionRepository.latestNumber(db, ctx.workspaceId, draft.elementId));
            await EnrichmentProposalRepository.create(
                db,
                ctx.workspaceId,
                {
                    bookId: session.bookId,
                    sessionId: session.id,
                    roundId: round.id,
                    kind: 'FIELD',
                    elementId: draft.elementId,
                    fieldKey: draft.fieldKey,
                    operation: draft.operation,
                    proposedValue: text.proposedValue,
                    baseVersion: versions.get(draft.elementId)!,
                    newKind: null,
                    newName: null,
                    newSummary: null,
                    flags: [...draft.flags],
                },
                draft.citedAnswerIds,
            );
        }
        if (draft.flags.length > 0) flagged++;
        proposed[draft.operation]++;
    }
    await finishRun(db, ctx, session, round, claim.runId, claim.attempt, 'OK', {
        ...step.metrics,
        proposed,
        flagged,
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
    // The stop has committed: nothing after it may turn the response into an error.
    let pending: number[];
    try {
        pending = await runInWorkspaceContext(ctx, async (db) => {
            const rounds = await InterviewRoundRepository.listForSession(db, ctx.workspaceId, sessionId, STOP_ROUNDS_READ);
            const runs = await ReconcileRunRepository.listForSession(db, ctx.workspaceId, sessionId, STOP_ROUNDS_READ);
            const ran = new Set(runs.map((r) => r.roundId));
            return rounds.filter((r) => r.status === 'CLOSED' && !ran.has(r.id)).map((r) => r.number);
        });
    } catch (err) {
        logger.warn('enrichment.reconcile_after_stop_failed', { component: 'enrichment', sessionId, error: err instanceof Error ? err.name : 'unknown' });
        return { interview, reconcile: [] };
    }
    const reconcile: ReconcileRunView[] = [];
    for (const n of pending) {
        const view = await reconcileAfterClose(ctx, bookId, sessionId, n, deps);
        if (view) reconcile.push(view);
    }
    return { interview, reconcile };
}
