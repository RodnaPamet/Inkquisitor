/**
 * ONE NIGHT'S CONTINUITY CHECK OF ONE BOOK (Phase 4.2, D28): the body of the
 * `continuity-check` job. The worker hands it `{ workspaceId, runId }`; nothing
 * else crosses Redis. The nightly dispatcher (`continuity-dispatch.ts`) queued
 * it because the book CHANGED since its last complete check.
 *
 *   1. LOOK     the run must be QUEUED; a deleted book ends it SKIPPED. The check
 *               runs as the workspace's longest-standing OWNER (else EDITOR):
 *               none ends it SKIPPED NO_ACTOR, nothing sent.
 *   2. CLAIM    QUEUED → RUNNING. Read the book's live facts (`ContinuityFactRepository`,
 *               bounded) and its story order (D25, the clock). Sweep the stale flags
 *               a save has already cleared (written CLEARED).
 *   3. RULES    every pair a rule calls contradictory (`continuity/rules.ts`), not
 *               already proposed, PROPOSED with basis RULE and its kind, under the
 *               book's fact lock. Free: rules run whatever the model's state.
 *   4. DEEP     the pass (`night-plan.ts`): the subjects with a fact new since the
 *               last complete pass, from the cursor, at most
 *               `CONTINUITY_CALLS_PER_NIGHT` deep calls a night, each inside the
 *               per-call cost budget (ENFORCED). Before each: the kill switch, a
 *               deployment that can make no call, or no evaluation record it
 *               accepts (D11) stops the night resumably; the model-call minute is
 *               waited out (never an uncharged call). The workspace's NIGHTLY
 *               SHARE of the month (D28 addendum) is checked with the call's
 *               worst case (NIGHTLY_CAP: resumable, the book waits for the next
 *               night), and again by the ledger as the call reserves. 2.1 checks the monthly
 *               ceiling: CEILING stops the night RESUMABLY and counts as no
 *               failure (the D27 addendum's rule). Each call's pairs are checked
 *               (`validateContinuityPairs`) and PROPOSED with basis DEEP; its cost
 *               is counted in a transaction of its own; the cursor moves past the
 *               subjects it covered, so a stop keeps every page done. A page that
 *               fails in a way it will fail every night (over the per-call budget,
 *               an answer never valid) is passed over after
 *               `CONTINUITY_PAGE_FAILURES_MAX` such nights in a row (4.H-a, #62
 *               item 3): its subjects counted on the check and shown on the page.
 *   5. FINISH   all subjects done: the pass is complete (`coveredThrough` = its
 *               target). Subjects left: DONE PAGED, the next night goes on from
 *               the cursor. Audit last.
 *
 * PASSED-OVER SUBJECTS ARE REMEMBERED (4.H-b, D32): a subject parked or
 * refused by the guard is stored on the check (`passedOver`, bounded by
 * `CONTINUITY_PASSED_OVER_MAX`; past it `passedOverCut`), retried in the next
 * pass whether or not it changed, and removed once a page covering it succeeds;
 * the Continuity page counts the outstanding and is never complete over one.
 *
 * THE DRAFT, WHEN THE AUTHOR ASKS (D35 addendum A, owner decision 2026-11-27):
 * a book whose continuity settings turn `deepReadsDraft` on also shows each
 * subject's live DRAFT facts (SCENE_TEXT, at most
 * `CONTINUITY_DRAFT_FACTS_PER_SUBJECT_MAX` a subject, the newest) beside its
 * bible facts, in the call's "draft-facts" block (the manuscript's claims, not
 * canon). A pair of two draft facts is refused (DRAFT_PAIR); a draft fact paired
 * with a BIBLE fact (an element's or a relation's version) is raised as a draft
 * mismatch — basis DRAFT, naming this run (`checkRunId`), the same table and the
 * same three choices as the draft reading's rules; paired with anything else (a
 * source fact, an explanation) it is refused (DRAFT_NOT_BIBLE). The rules are
 * not run on draft facts here (the draft reading runs them). The calls are this
 * check's: its purpose, its half of the night's share (addendum B). Off, the
 * check reads, sends and raises exactly what it did before.
 *
 * NOTHING IS RESOLVED (rule 1): every finding is a proposal the author decides
 * on the Continuity page, shown with both facts and their sources.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import {
    ContinuityCheckRepository,
    ContinuityFactRepository,
    ContinuityRunRepository,
    ContinuitySettingsRepository,
    placedElementsOf,
    StaleFlagRepository,
    type CheckDraftFactRow,
    type CheckFactRow,
    type ContinuityRunRow,
} from '@/app-layer/repositories/continuity.repository';
import { DraftMismatchRepository, SceneDraftReadRepository } from '@/app-layer/repositories/draft-facts.repository';
import { FactProposalRepository } from '@/app-layer/repositories/fact-layer.repository';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { BibleFactRepository } from '@/app-layer/repositories/source.repository';
import { WorkspaceRepository } from '@/app-layer/repositories/workspace.repository';
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import { continuityCallWorstCase } from '@/lib/continuity/cost';
import { defaultContinuityChecker, NIGHTLY_SHARE_REFUSED, type ContinuityChecker } from '@/lib/continuity/model-seam';
import { planNight, subjectOrderKey, type PlannedFact } from '@/lib/continuity/night-plan';
import { CONTINUITY_CALL_COST_BUDGET_MICRO_USD, CONTINUITY_PROMPT_VERSION, continuityBlocks, type CheckedDraftFactLine, type CheckedFactLine } from '@/lib/continuity/prompt';
import { continuityGate, type ContinuityGateVerdict } from '@/lib/continuity/record-gate';
import { detectRuleContradictions, type RuleFact } from '@/lib/continuity/rules';
import { NO_ORDER, storyClock, type StoryClock } from '@/lib/continuity/story-clock';
import { validateContinuityPairs } from '@/lib/continuity/validate';
import {
    CLOCK_ELEMENTS_MAX,
    CONTINUITY_CALLS_PER_NIGHT,
    CONTINUITY_FACTS_PER_CALL_MAX,
    CONTINUITY_FACTS_PER_CALL_MIN,
    CONTINUITY_DRAFT_FACTS_PER_SUBJECT_MAX,
    CONTINUITY_DRAFT_FACTS_READ_MAX,
    CONTINUITY_FACTS_READ_MAX,
    CONTINUITY_LIST_MAX,
    CONTINUITY_PASS_SETTLE_MS,
    continuityNightKey,
    CONTINUITY_PAGE_FAILURES_MAX,
    CONTINUITY_PASSED_OVER_MAX,
    CONTINUITY_PROPOSALS_PER_RUN_MAX,
    withPassedOver,
    type ContinuityOutcome,
    type ContinuityRunStatus,
    type ContradictionKind,
} from '@/lib/continuity/vocabulary';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import { defaultSleep, waitForModelRate } from './bible-facts';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason, nightShareStop, type NightlyShare } from './model-calls';
import { nightShareFor } from './night-share';
import { asDraftRuleFact, sceneBeat, type SceneTime } from '@/lib/draft-facts/compare';
import { bookSourceSet } from './source-common';
import { standingStaleFlags } from './stale-flags';

export interface ContinuityCheckDeps {
    checker?: (ctx: WorkspaceRequestContext) => ContinuityChecker;
    recordMode?: PackRecordMode;
    gate?: () => ContinuityGateVerdict;
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    charge?: (workspaceId: string, calls: number) => void;
    now?: () => Date;
    /** A call's worst case in µUSD over its data blocks (tests: a figure of their own). */
    worstCase?: (blocks: readonly AuthorDataBlock[]) => number;
    /** The night's bound (tests: a smaller one). */
    callsPerNight?: number;
    /** The workspace's nightly share in µUSD (tests: a figure of their own; default `CONTINUITY_NIGHTLY_SHARE` of the month's ceiling); the check's half is half of it (D35 addendum B). */
    nightlyCapMicroUsd?: number;
    factsPerCall?: number;
}

interface Counts {
    factsRead: number;
    ruleProposals: number;
    deepProposals: number;
    subjectsCovered: number;
    subjectsRemaining: number;
    callsMade: number;
}

interface Metrics {
    factsCut: boolean;
    clockKnown: boolean;
    rulePairsCompared: number;
    staleCleared: number;
    refusals: Record<string, number>;
    callIds: string[];
    subjectFactsCut: number;
    /** Subjects of a page the guard refused: passed over in this pass, never retried behind it. */
    guardRefusedSubjects?: number;
    /** 4.H-a (#62 item 3): subjects of a page that failed `CONTINUITY_PAGE_FAILURES_MAX` nights in a row, passed over tonight. */
    parkedSubjects?: number;
    /** D35 addendum A: the draft facts read (the author turned the deep reading of the draft on), and those past a bound. */
    draftFactsRead?: number;
    draftFactsCut?: number;
    /** D35 addendum A: draft-vs-bible mismatches the deep calls raised. */
    deepDraftMismatches?: number;
    /** D35 addendum B: why the night's share stopped the check — past the whole share, or past its half while the reading has work. */
    shareStop?: 'TOTAL' | 'HALF';
    errorCode?: string;
}

/** D35 addendum A: what a draft fact carries beside the fact — its scene, its claim, and where the scene stands. */
interface DraftSide {
    readonly sceneId: string;
    readonly sceneTitle: string | null;
    readonly claimKey: string;
    readonly time: SceneTime;
}

/** The facts a draft fact may be held against: the bible's own (an element's or a relation's version), never a source fact or an explanation. */
const BIBLE_KINDS: ReadonlySet<string> = new Set(['BIBLE_VERSION', 'RELATION_VERSION']);

/** The state after a run: RESUMABLE stops keep the pass; a finished pass moves `coveredThrough`. */
const STATUS_OF: Readonly<Record<ContinuityOutcome, ContinuityRunStatus>> = {
    OK: 'DONE',
    PAGED: 'DONE',
    NO_FACTS: 'DONE',
    NOTHING_NEW: 'DONE',
    BOOK_DELETED: 'SKIPPED',
    NO_ACTOR: 'SKIPPED',
    CEILING: 'STOPPED',
    NIGHTLY_CAP: 'STOPPED',
    KILL_SWITCH: 'STOPPED',
    AI_UNAVAILABLE: 'STOPPED',
    NOT_EVALUATED: 'STOPPED',
    MODEL_RATE_LIMITED: 'STOPPED',
    CALL_FAILED: 'STOPPED',
    GUARD_REFUSED: 'STOPPED',
    CALL_OVER_BUDGET: 'STOPPED',
    ABORTED: 'STOPPED',
    CLAIM_EXPIRED: 'STOPPED',
    INTERNAL: 'FAILED',
};

/** A call's failures the PAGE causes, so it fails the same way every night (4.H-a, #62 item 3): never a timeout or an outage. */
const PAGE_OWN_FAILURES: ReadonlySet<string> = new Set(['INVALID_OUTPUT', 'PROMPT_INVALID']);

/** Failures that mean nothing reached the provider unless the call reports tokens or cost (the guard and an abort can come either side). */
const REFUSED_BEFORE_SEND: ReadonlySet<string> = new Set(['KILL_SWITCH', 'WORKSPACE_CEILING', 'AI_UNAVAILABLE', 'PROMPT_INVALID', 'GUARD_REFUSED', 'ABORTED']);

const ORDER_NAME: Readonly<Record<string, string>> = { PLOT_BEAT: 'plot beats', TIMELINE_EVENT: 'timeline events' };

/** A fact's moment of entering the book: when it was written, or (a source fact) confirmed. */
function arrivedAt(f: CheckFactRow): Date {
    return f.sourceKind === 'SOURCE_CHUNK' && f.decidedAt ? f.decidedAt : f.createdAt;
}

function asRuleFact(f: CheckFactRow, draft?: DraftSide): RuleFact {
    if (draft) return asDraftRuleFact(f, draft.time);
    return {
        id: f.id,
        predicate: f.predicate,
        subjectElementId: f.subjectElementId,
        objectLiteral: f.objectLiteral,
        statement: f.statement,
        storyTimeFrom: f.storyTimeFrom,
        storyTimeTo: f.storyTimeTo,
        ownerElementId: f.sourceKind === 'BIBLE_VERSION' ? f.elementId : null,
    };
}

/** Older first: by when each was stated, then by id. */
function ordered(a: CheckFactRow, b: CheckFactRow): [CheckFactRow, CheckFactRow] {
    const d = a.statedAt.getTime() - b.statedAt.getTime();
    return d < 0 || (d === 0 && a.id < b.id) ? [a, b] : [b, a];
}

/** The member a nightly job acts as: the workspace's longest-standing OWNER, else EDITOR, who may edit the bible (5.3's draft reading uses it too). */
export async function actorFor(db: PrismaTx, workspaceId: string, requestId: string): Promise<WorkspaceRequestContext | null> {
    const slug = await WorkspaceRepository.findSlug(db, workspaceId);
    if (!slug) return null;
    for (const role of ['OWNER', 'EDITOR'] as const) {
        const m = await MembershipRepository.oldestOfRole(db, workspaceId, role);
        if (!m) continue;
        const permissions = getPermissionsForRole(m.role);
        if (permissions.bible.edit) return { requestId, userId: m.userId, workspaceId, workspaceSlug: slug, role: m.role, permissions };
    }
    return null;
}

/** Raise these pairs, older first, skipping any the book already holds (either order) or whose facts are no longer live. Under the book's fact lock. */
async function raisePairs(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    run: ContinuityRunRow,
    pairs: ReadonlyArray<{ a: CheckFactRow; b: CheckFactRow; kind: ContradictionKind }>,
    basis: 'RULE' | 'DEEP',
    refusals: Record<string, number>,
    max: number = CONTINUITY_PROPOSALS_PER_RUN_MAX,
): Promise<number> {
    if (pairs.length === 0) return 0;
    await BibleFactRepository.lockBook(db, bookId);
    const live = await ContinuityFactRepository.liveIds(db, ctx.workspaceId, [...new Set(pairs.flatMap((p) => [p.a.id, p.b.id]))]);
    const held = await FactProposalRepository.heldPairs(db, ctx.workspaceId, pairs.map((p) => ({ a: p.a.id, b: p.b.id })));

    const rows = [];
    for (const p of pairs) {
        if (!live.has(p.a.id) || !live.has(p.b.id)) {
            refusals.NOT_LIVE = (refusals.NOT_LIVE ?? 0) + 1;
            continue;
        }
        if (held.has(`${p.a.id}|${p.b.id}`)) {
            refusals.ALREADY_PROPOSED = (refusals.ALREADY_PROPOSED ?? 0) + 1;
            continue;
        }
        const [older, newer] = ordered(p.a, p.b);
        rows.push({ bookId, factId: older.id, newerFactId: newer.id, reason: 'CONTRADICTED' as const, basis, kind: p.kind, checkRunId: run.id });
    }
    // Bounded a night (the rule sweep's writes run inside one transaction): what is past the bound is raised on the
    // nights that follow, the held pairs checked first, so each pair is still raised once.
    const kept = rows.slice(0, max);
    if (rows.length > kept.length) refusals.DEFERRED = (refusals.DEFERRED ?? 0) + rows.length - kept.length;
    return FactProposalRepository.raise(db, ctx.workspaceId, kept);
}

/** A fact as one line of the deep call's facts block, with its place in the story order (a draft fact's: its scene's). */
function lineOf(f: CheckFactRow, clock: StoryClock, positions: ReadonlyMap<string, { name: string; position: number }>, draft?: DraftSide): CheckedFactLine {
    const rule = asRuleFact(f, draft);
    const p = clock.positionOf(rule);
    const at = p ? positions.get(p.elementId) : undefined;
    return {
        predicate: f.predicate,
        subjectName: f.subjectName,
        statement: f.statement,
        storyTimeFrom: rule.storyTimeFrom,
        storyTimeTo: rule.storyTimeTo,
        at: p && at ? { element: at.name, position: at.position, order: ORDER_NAME[p.kind] ?? 'story order' } : null,
    };
}

/**
 * D35 addendum A: raise the deep check's draft-vs-bible pairs as draft mismatches (basis DRAFT, naming this run), each
 * only between a live BIBLE fact and a live keyed draft fact; a draft fact against any other kind is refused
 * DRAFT_NOT_BIBLE. One open mismatch a bible fact, scene and claim (the partial unique index; a repeat is skipped).
 * Under the book's fact lock (taken alone).
 */
async function raiseDraftPairs(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    run: ContinuityRunRow,
    pairs: ReadonlyArray<{ bible: CheckFactRow; draft: CheckFactRow; side: DraftSide; kind: ContradictionKind }>,
    refusals: Record<string, number>,
    max: number,
): Promise<number> {
    if (pairs.length === 0) return 0;
    await BibleFactRepository.lockBook(db, bookId);
    const live = await ContinuityFactRepository.liveIds(db, ctx.workspaceId, [...new Set(pairs.flatMap((p) => [p.bible.id, p.draft.id]))]);
    const rows: Array<{ bookId: string; sceneId: string; factId: string; newerFactId: string; kind: string; draftClaimKey: string; checkRunId: string }> = [];
    for (const p of pairs) {
        if (!BIBLE_KINDS.has(p.bible.sourceKind)) {
            refusals.DRAFT_NOT_BIBLE = (refusals.DRAFT_NOT_BIBLE ?? 0) + 1;
            continue;
        }
        if (!live.has(p.bible.id) || !live.has(p.draft.id)) {
            refusals.NOT_LIVE = (refusals.NOT_LIVE ?? 0) + 1;
            continue;
        }
        rows.push({ bookId, sceneId: p.side.sceneId, factId: p.bible.id, newerFactId: p.draft.id, kind: p.kind, draftClaimKey: p.side.claimKey, checkRunId: run.id });
    }
    const kept = rows.slice(0, Math.max(0, max));
    if (rows.length > kept.length) refusals.DEFERRED = (refusals.DEFERRED ?? 0) + rows.length - kept.length;
    return DraftMismatchRepository.raise(db, ctx.workspaceId, kept);
}

/** Run one night's check (the job's body). */
export async function executeContinuityCheck(payload: { workspaceId: string; runId: string }, deps: ContinuityCheckDeps = {}): Promise<{ ran: boolean; outcome: ContinuityOutcome | null }> {
    const now = deps.now ?? (() => new Date());
    const scope = { workspaceId: payload.workspaceId, requestId: randomUUID() };
    const counts: Counts = { factsRead: 0, ruleProposals: 0, deepProposals: 0, subjectsCovered: 0, subjectsRemaining: 0, callsMade: 0 };
    const metrics: Metrics = { factsCut: false, clockKnown: false, rulePairsCompared: 0, staleCleared: 0, refusals: {}, callIds: [], subjectFactsCut: 0 };

    // 1. LOOK
    const looked = await runInWorkspaceContext(scope, async (db) => {
        const run = await ContinuityRunRepository.find(db, payload.workspaceId, payload.runId);
        if (!run || run.status !== 'QUEUED') return null;
        if (!(await BookRepository.find(db, payload.workspaceId, run.bookId))) return { run, ctx: null, skip: 'BOOK_DELETED' as const };
        const ctx = await actorFor(db, payload.workspaceId, scope.requestId);
        return { run, ctx, skip: ctx ? null : ('NO_ACTOR' as const) };
    });
    if (!looked) return { ran: false, outcome: null };
    const { run } = looked;
    // 4.H-a (#62 item 3): the pass's failed-page count and its passed-over subjects, as every save of the check writes them;
    // 4.H-b (D32): and the passed-over subjects themselves, outstanding until a page covering them succeeds.
    const page: { pageFailures?: number; parkedSubjects?: number; passedOver?: string[]; passedOverCut?: boolean } = {};
    const finish = async (outcome: ContinuityOutcome, claim: Date | undefined, state?: { coveredThrough?: Date | null; passTarget: Date | null; passCursor: string | null; pageFailures?: number; parkedSubjects?: number }) => {
        const at = now();
        await runInWorkspaceContext(looked.ctx ?? scope, async (db) => {
            const done = await ContinuityRunRepository.finish(db, payload.workspaceId, run.id, {
                status: STATUS_OF[outcome],
                outcome,
                from: claim ? ['RUNNING'] : ['QUEUED'],
                claim,
                passTarget: state?.passTarget,
                counts,
                promptVersion: counts.callsMade > 0 ? CONTINUITY_PROMPT_VERSION : null,
                metrics: metrics as unknown as Prisma.InputJsonValue,
                at,
            });
            if (!done) return;
            if (state && looked.ctx) await ContinuityCheckRepository.save(db, payload.workspaceId, run.bookId, { ...page, ...state, lastRunAt: at, lastOutcome: outcome });
            // AUDIT LAST (3.H).
            if (looked.ctx) {
                await logEvent(looked.ctx, { action: 'CONTINUITY_CHECKED', entityType: 'ContinuityRun', entityId: run.id, details: { bookId: run.bookId, outcome, ...counts, deepDraftMismatches: metrics.deepDraftMismatches ?? 0 } }, { db, actorType: 'SYSTEM' });
            }
        });
        return { ran: true, outcome };
    };
    if (looked.skip || !looked.ctx) return finish(looked.skip ?? 'NO_ACTOR', undefined);
    const ctx = looked.ctx;

    // 2. CLAIM
    const claimed = await runInWorkspaceContext(ctx, async (db) => {
        const at = now();
        if (!(await ContinuityRunRepository.claim(db, ctx.workspaceId, run.id, at))) return null;
        const state = await ContinuityCheckRepository.ensure(db, ctx.workspaceId, run.bookId);
        const set = await bookSourceSet(db, ctx, run.bookId);
        const facts = await ContinuityFactRepository.listLiveForBook(db, ctx.workspaceId, run.bookId, set.bookSourceIds, CONTINUITY_FACTS_READ_MAX + 1);
        const placed = await placedElementsOf(db, ctx.workspaceId, run.bookId, CLOCK_ELEMENTS_MAX + 1);
        const subjectIds = [...new Set(facts.map((f) => f.subjectElementId).filter((x): x is string => !!x))];
        const elements = await BibleElementRepository.listByIds(db, ctx.workspaceId, run.bookId, subjectIds);
        // D35 addendum A: the draft's facts too, only for a book whose author turned that on (off: nothing is read).
        const settings = await ContinuitySettingsRepository.find(db, ctx.workspaceId, run.bookId);
        const draftFacts: CheckDraftFactRow[] = settings?.deepReadsDraft ? await ContinuityFactRepository.listLiveDraftForBook(db, ctx.workspaceId, run.bookId, CONTINUITY_DRAFT_FACTS_READ_MAX + 1) : [];
        const scenes = await SceneDraftReadRepository.sceneTimes(db, ctx.workspaceId, run.bookId, [...new Set(draftFacts.slice(0, CONTINUITY_DRAFT_FACTS_READ_MAX).map((f) => f.sceneId!))]);
        // The sweep: open flags their entry's save has cleared are written CLEARED (lists stay short).
        const open = await StaleFlagRepository.listOpen(db, ctx.workspaceId, run.bookId, CONTINUITY_LIST_MAX * 5);
        const { cleared } = await standingStaleFlags(db, ctx.workspaceId, open);
        metrics.staleCleared = await StaleFlagRepository.markCleared(db, ctx.workspaceId, cleared.map((f) => f.id));
        return { claim: at, state, facts, placed, elements, draftReading: settings?.deepReadsDraft === true, draftSince: settings?.deepReadsDraftSince ?? null, draftFacts, scenes };
    });
    if (!claimed) return { ran: false, outcome: null };
    const { claim, state } = claimed;
    metrics.factsCut = claimed.facts.length > CONTINUITY_FACTS_READ_MAX;
    const facts = claimed.facts.slice(0, CONTINUITY_FACTS_READ_MAX);
    counts.factsRead = facts.length;
    // A new pass covers facts stamped up to a moment SETTLED before the claim, never the claim itself: a fact is stamped
    // when its transaction writes it and seen only once that commits, so one stamped just before the claim may commit
    // just after this read; covered through the claim, it would be skipped for ever (and discovery would never queue
    // the book for it). Facts inside the margin are read now and covered by the next pass.
    const passTarget = state.passTarget ?? new Date(claim.getTime() - CONTINUITY_PASS_SETTLE_MS);
    const keep = { passTarget: state.passTarget, passCursor: state.passCursor };
    page.pageFailures = state.pageFailures;
    page.parkedSubjects = state.parkedSubjects;
    page.passedOver = [...state.passedOver];
    page.passedOverCut = state.passedOverCut;
    /** 4.H-b (D32): remember passed-over subjects (bounded; past the bound the next pass checks every subject). */
    const rememberPassedOver = (keys: readonly string[]) => {
        const next = withPassedOver(page.passedOver ?? [], keys);
        page.passedOver = next.list;
        page.passedOverCut = (page.passedOverCut ?? false) || next.cut;
    };
    /**
     * A page that failed this night in a way it will fail every night (over the per-call budget; an answer that is never
     * valid; text that repeats the prompt): counted, and once it has failed `CONTINUITY_PAGE_FAILURES_MAX` nights in a
     * row PASSED OVER — the cursor moves past its subjects, counted on the check and shown — so it never holds the pass.
     */
    const pageFailed = (subjectKeys: readonly string[]): string | null => {
        page.pageFailures = (page.pageFailures ?? 0) + 1;
        if (page.pageFailures < CONTINUITY_PAGE_FAILURES_MAX || subjectKeys.length === 0) return null;
        page.pageFailures = 0;
        page.parkedSubjects = (page.parkedSubjects ?? 0) + subjectKeys.length;
        metrics.parkedSubjects = (metrics.parkedSubjects ?? 0) + subjectKeys.length;
        rememberPassedOver(subjectKeys);
        counts.subjectsRemaining = Math.max(0, counts.subjectsRemaining - subjectKeys.length);
        return subjectKeys[subjectKeys.length - 1];
    };

    try {
        // Rule 6: a book with no live fact has nothing checked; it is never reported clean.
        // Its coverage still moves: the book was due for facts this run cannot check (an unlinked subject), and a
        // coverage left behind them would queue the book again every night, for ever, to read nothing.
        if (facts.length === 0) {
            // Nothing is left to check, so nothing passed over is outstanding either (4.H-b, D32).
            page.passedOver = [];
            page.passedOverCut = false;
            return await finish('NO_FACTS', claim, { coveredThrough: passTarget, passTarget: null, passCursor: null });
        }

        const placed = claimed.placed.slice(0, CLOCK_ELEMENTS_MAX);
        metrics.clockKnown = claimed.placed.length <= CLOCK_ELEMENTS_MAX;
        const clock = metrics.clockKnown ? storyClock(placed.map((e) => ({ id: e.id, kind: e.kind, name: e.name, orderRank: e.orderRank! }))) : NO_ORDER;
        const positions = new Map<string, { name: string; position: number }>();
        const byKind = new Map<string, number>();
        for (const e of placed) {
            const n = (byKind.get(e.kind) ?? 0) + 1;
            byKind.set(e.kind, n);
            positions.set(e.id, { name: e.name, position: n });
        }
        const byId = new Map<string, CheckFactRow>(facts.map((f) => [f.id, f] as const));
        // D35 addendum A: each draft fact read, with its scene and where the scene stands in story time.
        const draftOf = new Map<string, DraftSide>();
        const draftBySubject = new Map<string, CheckFactRow[]>();
        if (claimed.draftReading) {
            metrics.draftFactsCut = Math.max(0, claimed.draftFacts.length - CONTINUITY_DRAFT_FACTS_READ_MAX);
            const sceneOf = new Map(claimed.scenes.map((sc) => [sc.id, sc] as const));
            for (const f of claimed.draftFacts.slice(0, CONTINUITY_DRAFT_FACTS_READ_MAX)) {
                const sc = f.sceneId ? sceneOf.get(f.sceneId) : undefined;
                if (!sc || !f.dedupeKey || !f.subjectElementId) continue;
                const list = draftBySubject.get(f.subjectElementId) ?? [];
                // The newest of a subject's draft facts (the read orders them so), bounded: a cut is counted.
                if (list.length >= CONTINUITY_DRAFT_FACTS_PER_SUBJECT_MAX) {
                    metrics.draftFactsCut = (metrics.draftFactsCut ?? 0) + 1;
                    continue;
                }
                list.push(f);
                draftBySubject.set(f.subjectElementId, list);
                draftOf.set(f.id, { sceneId: sc.id, sceneTitle: sc.title, claimKey: f.dedupeKey, time: { beatElementId: sceneBeat(sc.beatLinks.map((b) => b.beatElementId), clock), storyTime: sc.storyTime } });
                byId.set(f.id, f);
            }
            metrics.draftFactsRead = draftOf.size;
        }

        // 3. RULES (free, whatever the model's state).
        const rules = detectRuleContradictions(facts.map((f) => asRuleFact(f)), clock);
        metrics.rulePairsCompared = rules.compared;
        counts.ruleProposals = await runInWorkspaceContext(ctx, (db) =>
            raisePairs(db, ctx, run.bookId, run, rules.pairs.map((p) => ({ a: byId.get(p.a)!, b: byId.get(p.b)!, kind: p.kind })), 'RULE', metrics.refusals),
        );

        // 4. DEEP: the subjects with a fact new since the last complete pass.
        const covered = state.coveredThrough?.getTime() ?? Number.NEGATIVE_INFINITY;
        const elementOf = new Map(claimed.elements.map((e) => [e.id, e] as const));
        const bySubject = new Map<string, CheckFactRow[]>();
        for (const f of facts) {
            if (!f.subjectElementId || !elementOf.has(f.subjectElementId)) continue;
            const list = bySubject.get(f.subjectElementId);
            if (list) list.push(f);
            else bySubject.set(f.subjectElementId, [f]);
        }
        // A subject's draft facts join its bible facts (a subject the bible says nothing about has nothing to hold the
        // draft against: two draft facts are never compared).
        for (const [subjectId, list] of bySubject) list.push(...(draftBySubject.get(subjectId) ?? []));
        const subjects: Array<{ key: string; facts: Array<PlannedFact & { row: CheckFactRow }> }> = [];
        // 4.H-b (D32): the subjects passed over before (outstanding) are retried in this pass whether or not they changed;
        // with more passed over than the list held (`passedOverCut`), every subject is.
        const outstanding = new Set(state.passedOver);
        for (const [subjectId, list] of bySubject) {
            const e = elementOf.get(subjectId)!;
            const key = subjectOrderKey(e.kind, e.id);
            const inPass = (t: number) => t > covered && t <= passTarget.getTime();
            // A draft fact is new to the check from when it arrived or (addendum A) from when the author turned the reading
            // on, whichever is later: the draft read before that has never been shown to it.
            const draftSince = claimed.draftSince?.getTime() ?? Number.NEGATIVE_INFINITY;
            const changed = list.some((f) => inPass(draftOf.has(f.id) ? Math.max(arrivedAt(f).getTime(), draftSince) : arrivedAt(f).getTime()));
            if (!changed && !outstanding.has(key) && !state.passedOverCut) continue;
            subjects.push({ key, facts: list.map((f) => ({ id: f.id, createdAt: arrivedAt(f).getTime(), row: f })) });
        }
        // A remembered subject with no live linked fact left has nothing to check: it is no longer outstanding (unless the
        // read was cut, when a subject past the cut cannot be told from one gone).
        if (!metrics.factsCut) {
            const present = new Set([...bySubject.keys()].map((id) => subjectOrderKey(elementOf.get(id)!.kind, id)));
            page.passedOver = (page.passedOver ?? []).filter((k) => present.has(k));
        }
        /** The pass is complete: what is still outstanding stays, and a cut stays only while the list is full. */
        const completed = () => {
            page.passedOverCut = (page.passedOver ?? []).length >= CONTINUITY_PASSED_OVER_MAX;
        };
        // Nothing left to page through: a pass under way is complete; with none, nothing changed since the last one.
        if (subjects.length === 0) {
            completed();
            return await finish(state.passTarget ? 'OK' : 'NOTHING_NEW', claim, { coveredThrough: passTarget, passTarget: null, passCursor: null });
        }
        // A NEW pass starts with no failed page and nothing passed over (the last pass's count stays shown until then).
        if (!state.passTarget) {
            page.pageFailures = 0;
            page.parkedSubjects = 0;
        }

        const unavailable = modelUnavailableReason();
        if (unavailable) {
            metrics.errorCode = unavailable;
            return await finish(unavailable === 'AI_DISABLED' ? 'KILL_SWITCH' : 'AI_UNAVAILABLE', claim, { passTarget, passCursor: keep.passCursor });
        }
        const verdict = (deps.gate ?? (() => continuityGate(deps.recordMode ?? deploymentPackRecordMode())))();
        if (!verdict.mounted) {
            metrics.errorCode = verdict.reason;
            return await finish('NOT_EVALUATED', claim, { passTarget, passCursor: keep.passCursor });
        }

        const orderNames = (rows: readonly CheckFactRow[]) => {
            const used = new Map<string, Array<{ name: string; position: number }>>();
            for (const f of rows) {
                const p = clock.positionOf(asRuleFact(f, draftOf.get(f.id)));
                const at = p ? positions.get(p.elementId) : undefined;
                if (!p || !at) continue;
                const list = used.get(p.kind) ?? [];
                if (!list.some((x) => x.position === at.position)) list.push(at);
                used.set(p.kind, list);
            }
            return [...used].map(([kind, list]) => ({ order: ORDER_NAME[kind] ?? 'story order', names: list.sort((a, b) => a.position - b.position).map((x) => `${x.name} (position ${x.position})`) }));
        };
        // A page as shown: the bible's facts numbered first, then (addendum A) the draft's in a block of their own.
        const shownOrder = (rows: readonly CheckFactRow[]): CheckFactRow[] => [...rows.filter((f) => !draftOf.has(f.id)), ...rows.filter((f) => draftOf.has(f.id))];
        const blocksOf = (rows: readonly CheckFactRow[]) => {
            const shown = shownOrder(rows);
            const draftLines: CheckedDraftFactLine[] = shown.filter((f) => draftOf.has(f.id)).map((f) => ({ ...lineOf(f, clock, positions, draftOf.get(f.id)), sceneTitle: draftOf.get(f.id)!.sceneTitle }));
            return continuityBlocks({ facts: shown.filter((f) => !draftOf.has(f.id)).map((f) => lineOf(f, clock, positions)), ...(draftLines.length > 0 ? { draftFacts: draftLines } : {}), orders: orderNames(shown) });
        };
        const worst = deps.worstCase ?? ((blocks: readonly AuthorDataBlock[]) => continuityCallWorstCase(blocks));
        const plan = planNight({
            subjects,
            cursor: keep.passCursor,
            maxCalls: deps.callsPerNight ?? CONTINUITY_CALLS_PER_NIGHT,
            maxFacts: deps.factsPerCall ?? CONTINUITY_FACTS_PER_CALL_MAX,
            minFacts: Math.min(CONTINUITY_FACTS_PER_CALL_MIN, deps.factsPerCall ?? CONTINUITY_FACTS_PER_CALL_MAX),
            budget: CONTINUITY_CALL_COST_BUDGET_MICRO_USD,
            worst: (rows) => worst(blocksOf(rows.map((r) => r.row))),
        });
        metrics.subjectFactsCut = plan.cut;
        counts.subjectsRemaining = plan.remaining + plan.covered;
        if (plan.calls.length === 0 && plan.overBudget) {
            const past = pageFailed(plan.blockedKey ? [plan.blockedKey] : []);
            return await finish('CALL_OVER_BUDGET', claim, { passTarget, passCursor: past ?? keep.passCursor });
        }

        // The night's share of the month (D28 addendum): every deep call of the workspace in the night's window counts,
        // whatever its book; checked here with this call's worst case, and again by the ledger as the call reserves.
        // Since 5.3 (D35 item 2) the night's share is ONE budget for the deep check and the nightly draft reading together,
        // and (addendum B) the check takes at most half of it while the reading still has work tonight.
        const share: NightlyShare = nightShareFor(ctx, 'continuity', { claim, nightKey: run.nightKey ?? continuityNightKey(claim), capMicroUsd: deps.nightlyCapMicroUsd });
        const checker = (deps.checker ?? ((c: WorkspaceRequestContext) => defaultContinuityChecker(c, {}, share)))(ctx);
        let cursor = keep.passCursor;
        for (const call of plan.calls) {
            if (deps.signal?.aborted) return await finish('ABORTED', claim, { passTarget, passCursor: cursor });
            const callWorst = worst(blocksOf(call.facts.map((f) => f.row)));
            const stop = await runInWorkspaceContext(ctx, (db) => nightShareStop(db, ctx, share, callWorst));
            if (stop) {
                metrics.shareStop = stop;
                return await finish('NIGHTLY_CAP', claim, { passTarget, passCursor: cursor });
            }
            if (!(await waitForModelRate(ctx, deps.charge ?? chargeModelCalls, deps.sleep ?? defaultSleep, deps.signal))) {
                return await finish(deps.signal?.aborted ? 'ABORTED' : 'MODEL_RATE_LIMITED', claim, { passTarget, passCursor: cursor });
            }
            const rows = shownOrder(call.facts.map((f) => f.row));
            const result = await checker.extract({ data: blocksOf(rows), bookId: run.bookId }, deps.signal);
            // A call refused before it was sent (the switch, a limit, no deployment, the input guard) is no call made.
            if (result.ok || !REFUSED_BEFORE_SEND.has(result.failure) || result.tokensUsed > 0 || result.costMicroUsd > 0) counts.callsMade++;
            metrics.callIds.push(...result.callIds);
            await runInWorkspaceContext(ctx, (db) => ContinuityRunRepository.addCost(db, ctx.workspaceId, run.id, result.costMicroUsd));
            if (!result.ok) {
                metrics.errorCode = result.errorCode;
                const outcome: ContinuityOutcome =
                    result.failure === 'KILL_SWITCH' ? 'KILL_SWITCH'
                    : result.failure === 'WORKSPACE_CEILING' ? (result.errorCode === NIGHTLY_SHARE_REFUSED ? 'NIGHTLY_CAP' : 'CEILING')
                    : result.failure === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE'
                    : result.failure === 'ABORTED' ? 'ABORTED'
                    : result.failure === 'GUARD_REFUSED' ? 'GUARD_REFUSED'
                    : 'CALL_FAILED';
                if (outcome === 'GUARD_REFUSED') {
                    // The same facts trip the guard the same way every night (on the way out, after a paid call): the
                    // night stops, but the pass resumes PAST this page, its subjects counted as refused, never retried
                    // for ever behind it (4.0's rule: a refused chunk yields nothing).
                    metrics.guardRefusedSubjects = (metrics.guardRefusedSubjects ?? 0) + call.subjectKeys.length;
                    // Passed over unchecked, so counted with the pass's passed-over subjects (4.H-a): the pass that
                    // finishes past them is never "every fact checked" (rule 6).
                    page.parkedSubjects = (page.parkedSubjects ?? 0) + call.subjectKeys.length;
                    rememberPassedOver(call.subjectKeys);
                    counts.subjectsRemaining -= call.subjectKeys.length;
                    return await finish(outcome, claim, { passTarget, passCursor: call.subjectKeys[call.subjectKeys.length - 1] });
                }
                // An answer that is never valid, or text that repeats the prompt, fails the same page every night.
                if (outcome === 'CALL_FAILED' && PAGE_OWN_FAILURES.has(result.failure)) {
                    const past = pageFailed(call.subjectKeys);
                    return await finish(outcome, claim, { passTarget, passCursor: past ?? cursor });
                }
                return await finish(outcome, claim, { passTarget, passCursor: cursor });
            }
            const v = validateContinuityPairs(result.output, rows.map((r) => r.id), { draftIds: new Set(rows.filter((r) => draftOf.has(r.id)).map((r) => r.id)) });
            for (const [code, n] of Object.entries(v.refusals)) metrics.refusals[code] = (metrics.refusals[code] ?? 0) + (n ?? 0);
            const callCursor = call.subjectKeys[call.subjectKeys.length - 1];
            // Two bible facts: a contradiction (basis DEEP). A bible fact and a draft fact: a draft mismatch (addendum A).
            const biblePairs = v.pairs.filter((p) => !draftOf.has(p.a) && !draftOf.has(p.b));
            const draftPairs = v.pairs.filter((p) => draftOf.has(p.a) !== draftOf.has(p.b)).map((p) => {
                const [bibleId, draftId] = draftOf.has(p.a) ? [p.b, p.a] : [p.a, p.b];
                return { bible: byId.get(bibleId)!, draft: byId.get(draftId)!, side: draftOf.get(draftId)!, kind: p.kind };
            });
            const raised = await runInWorkspaceContext(ctx, async (db) => {
                const n = await raisePairs(db, ctx, run.bookId, run, biblePairs.map((p) => ({ a: byId.get(p.a)!, b: byId.get(p.b)!, kind: p.kind })), 'DEEP', metrics.refusals);
                const drafts = await raiseDraftPairs(db, ctx, run.bookId, run, draftPairs, metrics.refusals, CONTINUITY_PROPOSALS_PER_RUN_MAX - n);
                if (drafts > 0) metrics.deepDraftMismatches = (metrics.deepDraftMismatches ?? 0) + drafts;
                // The page is done: the cursor moves past it, so a stop later in the night keeps it. Its subjects are
                // checked now, so none of them is outstanding any more (4.H-b, D32).
                page.pageFailures = 0;
                const done = new Set(call.subjectKeys);
                page.passedOver = (page.passedOver ?? []).filter((k) => !done.has(k));
                await ContinuityCheckRepository.save(db, ctx.workspaceId, run.bookId, { ...page, passTarget, passCursor: callCursor, lastRunAt: now(), lastOutcome: 'PAGED' });
                return n;
            });
            counts.deepProposals += raised;
            counts.subjectsCovered += call.subjectKeys.length;
            // What a stop later in the night leaves: the pass's subjects less those its calls have covered.
            counts.subjectsRemaining -= call.subjectKeys.length;
            cursor = callCursor;
        }
        if (plan.remaining > 0 || plan.overBudget) {
            return await finish(plan.overBudget && plan.calls.length === 0 ? 'CALL_OVER_BUDGET' : 'PAGED', claim, { passTarget, passCursor: cursor });
        }
        // The pass is complete: every live fact up to its target has been checked (but for the subjects still
        // outstanding, which the page counts and the next pass retries: 4.H-b, D32).
        completed();
        return await finish('OK', claim, { coveredThrough: passTarget, passTarget: null, passCursor: null });
    } catch (err) {
        logger.error('continuity.check_failed', { component: 'continuity', runId: run.id, error: err instanceof Error ? err.name : 'unknown' });
        metrics.errorCode = 'INTERNAL';
        return finish('INTERNAL', claim, { passTarget, passCursor: keep.passCursor });
    }
}
