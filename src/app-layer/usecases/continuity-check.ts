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
 *               waited out (never an uncharged call). 2.1 checks the monthly
 *               ceiling: CEILING stops the night RESUMABLY and counts as no
 *               failure (the D27 addendum's rule). Each call's pairs are checked
 *               (`validateContinuityPairs`) and PROPOSED with basis DEEP; its cost
 *               is counted in a transaction of its own; the cursor moves past the
 *               subjects it covered, so a stop keeps every page done.
 *   5. FINISH   all subjects done: the pass is complete (`coveredThrough` = its
 *               target). Subjects left: DONE PAGED, the next night goes on from
 *               the cursor. Audit last.
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
    placedElementsOf,
    StaleFlagRepository,
    type CheckFactRow,
    type ContinuityRunRow,
} from '@/app-layer/repositories/continuity.repository';
import { FactProposalRepository } from '@/app-layer/repositories/fact-layer.repository';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { BibleFactRepository } from '@/app-layer/repositories/source.repository';
import { WorkspaceRepository } from '@/app-layer/repositories/workspace.repository';
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import { continuityCallWorstCase } from '@/lib/continuity/cost';
import { defaultContinuityChecker, type ContinuityChecker } from '@/lib/continuity/model-seam';
import { planNight, subjectOrderKey, type PlannedFact } from '@/lib/continuity/night-plan';
import { CONTINUITY_CALL_COST_BUDGET_MICRO_USD, CONTINUITY_PROMPT_VERSION, continuityBlocks, type CheckedFactLine } from '@/lib/continuity/prompt';
import { continuityGate, type ContinuityGateVerdict } from '@/lib/continuity/record-gate';
import { detectRuleContradictions, type RuleFact } from '@/lib/continuity/rules';
import { NO_ORDER, storyClock, type StoryClock } from '@/lib/continuity/story-clock';
import { validateContinuityPairs } from '@/lib/continuity/validate';
import {
    CLOCK_ELEMENTS_MAX,
    CONTINUITY_CALLS_PER_NIGHT,
    CONTINUITY_FACTS_PER_CALL_MAX,
    CONTINUITY_FACTS_PER_CALL_MIN,
    CONTINUITY_FACTS_READ_MAX,
    CONTINUITY_LIST_MAX,
    CONTINUITY_PROPOSALS_PER_RUN_MAX,
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
import { modelUnavailableReason } from './model-calls';
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
    errorCode?: string;
}

/** The state after a run: RESUMABLE stops keep the pass; a finished pass moves `coveredThrough`. */
const STATUS_OF: Readonly<Record<ContinuityOutcome, ContinuityRunStatus>> = {
    OK: 'DONE',
    PAGED: 'DONE',
    NO_FACTS: 'DONE',
    NOTHING_NEW: 'DONE',
    BOOK_DELETED: 'SKIPPED',
    NO_ACTOR: 'SKIPPED',
    CEILING: 'STOPPED',
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

const ORDER_NAME: Readonly<Record<string, string>> = { PLOT_BEAT: 'plot beats', TIMELINE_EVENT: 'timeline events' };

/** A fact's moment of entering the book: when it was written, or (a source fact) confirmed. */
function arrivedAt(f: CheckFactRow): Date {
    return f.sourceKind === 'SOURCE_CHUNK' && f.decidedAt ? f.decidedAt : f.createdAt;
}

function asRuleFact(f: CheckFactRow): RuleFact {
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

async function actorFor(db: PrismaTx, workspaceId: string, requestId: string): Promise<WorkspaceRequestContext | null> {
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

/** A fact as one line of the deep call's facts block, with its place in the story order. */
function lineOf(f: CheckFactRow, clock: StoryClock, positions: ReadonlyMap<string, { name: string; position: number }>): CheckedFactLine {
    const p = clock.positionOf(asRuleFact(f));
    const at = p ? positions.get(p.elementId) : undefined;
    return {
        predicate: f.predicate,
        subjectName: f.subjectName,
        statement: f.statement,
        storyTimeFrom: f.storyTimeFrom,
        storyTimeTo: f.storyTimeTo,
        at: p && at ? { element: at.name, position: at.position, order: ORDER_NAME[p.kind] ?? 'story order' } : null,
    };
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
    const finish = async (outcome: ContinuityOutcome, claim: Date | undefined, state?: { coveredThrough?: Date | null; passTarget: Date | null; passCursor: string | null }) => {
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
            if (state && looked.ctx) await ContinuityCheckRepository.save(db, payload.workspaceId, run.bookId, { ...state, lastRunAt: at, lastOutcome: outcome });
            // AUDIT LAST (3.H).
            if (looked.ctx) {
                await logEvent(looked.ctx, { action: 'CONTINUITY_CHECKED', entityType: 'ContinuityRun', entityId: run.id, details: { bookId: run.bookId, outcome, ...counts } }, { db, actorType: 'SYSTEM' });
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
        // The sweep: open flags their entry's save has cleared are written CLEARED (lists stay short).
        const open = await StaleFlagRepository.listOpen(db, ctx.workspaceId, run.bookId, CONTINUITY_LIST_MAX * 5);
        const { cleared } = await standingStaleFlags(db, ctx.workspaceId, open);
        metrics.staleCleared = await StaleFlagRepository.markCleared(db, ctx.workspaceId, cleared.map((f) => f.id));
        return { claim: at, state, facts, placed, elements };
    });
    if (!claimed) return { ran: false, outcome: null };
    const { claim, state } = claimed;
    metrics.factsCut = claimed.facts.length > CONTINUITY_FACTS_READ_MAX;
    const facts = claimed.facts.slice(0, CONTINUITY_FACTS_READ_MAX);
    counts.factsRead = facts.length;
    const passTarget = state.passTarget ?? claim;
    const keep = { passTarget: state.passTarget, passCursor: state.passCursor };

    try {
        // Rule 6: a book with no live fact has nothing checked; it is never reported clean.
        // Its coverage still moves: the book was due for facts this run cannot check (an unlinked subject), and a
        // coverage left behind them would queue the book again every night, for ever, to read nothing.
        if (facts.length === 0) return await finish('NO_FACTS', claim, { coveredThrough: passTarget, passTarget: null, passCursor: null });

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
        const byId = new Map(facts.map((f) => [f.id, f] as const));

        // 3. RULES (free, whatever the model's state).
        const rules = detectRuleContradictions(facts.map(asRuleFact), clock);
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
        const subjects: Array<{ key: string; facts: Array<PlannedFact & { row: CheckFactRow }> }> = [];
        for (const [subjectId, list] of bySubject) {
            const changed = list.some((f) => arrivedAt(f).getTime() > covered && arrivedAt(f).getTime() <= passTarget.getTime());
            if (!changed) continue;
            const e = elementOf.get(subjectId)!;
            subjects.push({ key: subjectOrderKey(e.kind, e.id), facts: list.map((f) => ({ id: f.id, createdAt: arrivedAt(f).getTime(), row: f })) });
        }
        // Nothing left to page through: a pass under way is complete; with none, nothing changed since the last one.
        if (subjects.length === 0) return await finish(state.passTarget ? 'OK' : 'NOTHING_NEW', claim, { coveredThrough: passTarget, passTarget: null, passCursor: null });

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
                const p = clock.positionOf(asRuleFact(f));
                const at = p ? positions.get(p.elementId) : undefined;
                if (!p || !at) continue;
                const list = used.get(p.kind) ?? [];
                if (!list.some((x) => x.position === at.position)) list.push(at);
                used.set(p.kind, list);
            }
            return [...used].map(([kind, list]) => ({ order: ORDER_NAME[kind] ?? 'story order', names: list.sort((a, b) => a.position - b.position).map((x) => `${x.name} (position ${x.position})`) }));
        };
        const blocksOf = (rows: readonly CheckFactRow[]) => continuityBlocks({ facts: rows.map((f) => lineOf(f, clock, positions)), orders: orderNames(rows) });
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
        if (plan.calls.length === 0 && plan.overBudget) return await finish('CALL_OVER_BUDGET', claim, { passTarget, passCursor: keep.passCursor });

        const checker = (deps.checker ?? defaultContinuityChecker)(ctx);
        let cursor = keep.passCursor;
        for (const call of plan.calls) {
            if (deps.signal?.aborted) return await finish('ABORTED', claim, { passTarget, passCursor: cursor });
            if (!(await waitForModelRate(ctx, deps.charge ?? chargeModelCalls, deps.sleep ?? defaultSleep, deps.signal))) {
                return await finish(deps.signal?.aborted ? 'ABORTED' : 'MODEL_RATE_LIMITED', claim, { passTarget, passCursor: cursor });
            }
            const rows = call.facts.map((f) => f.row);
            const result = await checker.extract({ data: blocksOf(rows), bookId: run.bookId }, deps.signal);
            counts.callsMade++;
            metrics.callIds.push(...result.callIds);
            await runInWorkspaceContext(ctx, (db) => ContinuityRunRepository.addCost(db, ctx.workspaceId, run.id, result.costMicroUsd));
            if (!result.ok) {
                metrics.errorCode = result.errorCode;
                const outcome: ContinuityOutcome =
                    result.failure === 'KILL_SWITCH' ? 'KILL_SWITCH'
                    : result.failure === 'WORKSPACE_CEILING' ? 'CEILING'
                    : result.failure === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE'
                    : result.failure === 'ABORTED' ? 'ABORTED'
                    : result.failure === 'GUARD_REFUSED' ? 'GUARD_REFUSED'
                    : 'CALL_FAILED';
                if (outcome === 'GUARD_REFUSED') {
                    // The same facts trip the guard the same way every night (on the way out, after a paid call): the
                    // night stops, but the pass resumes PAST this page, its subjects counted as refused, never retried
                    // for ever behind it (4.0's rule: a refused chunk yields nothing).
                    metrics.guardRefusedSubjects = (metrics.guardRefusedSubjects ?? 0) + call.subjectKeys.length;
                    counts.subjectsRemaining -= call.subjectKeys.length;
                    return await finish(outcome, claim, { passTarget, passCursor: call.subjectKeys[call.subjectKeys.length - 1] });
                }
                return await finish(outcome, claim, { passTarget, passCursor: cursor });
            }
            const v = validateContinuityPairs(result.output, rows.map((r) => r.id));
            for (const [code, n] of Object.entries(v.refusals)) metrics.refusals[code] = (metrics.refusals[code] ?? 0) + (n ?? 0);
            const callCursor = call.subjectKeys[call.subjectKeys.length - 1];
            const raised = await runInWorkspaceContext(ctx, async (db) => {
                const n = await raisePairs(db, ctx, run.bookId, run, v.pairs.map((p) => ({ a: byId.get(p.a)!, b: byId.get(p.b)!, kind: p.kind })), 'DEEP', metrics.refusals);
                // The page is done: the cursor moves past it, so a stop later in the night keeps it.
                await ContinuityCheckRepository.save(db, ctx.workspaceId, run.bookId, { passTarget, passCursor: callCursor, lastRunAt: now(), lastOutcome: 'PAGED' });
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
        // The pass is complete: every live fact up to its target has been checked.
        return await finish('OK', claim, { coveredThrough: passTarget, passTarget: null, passCursor: null });
    } catch (err) {
        logger.error('continuity.check_failed', { component: 'continuity', runId: run.id, error: err instanceof Error ? err.name : 'unknown' });
        metrics.errorCode = 'INTERNAL';
        return finish('INTERNAL', claim, { passTarget, passCursor: keep.passCursor });
    }
}
