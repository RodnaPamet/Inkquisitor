/**
 * THE STRESS TEST (Phase 4.3, D29): a deep-tier pass over a book's canon that
 * finds its weakest points and turns each into QUESTIONS — never verdicts,
 * never rewrites (D3; rule 1). Nothing here writes the bible.
 *
 *   ESTIMATE   `getStressTestPage` reads the canon (`readStressCanon`: the
 *              book, its elements with their summaries and places in the story
 *              order, the 4.1 retriever's facts and passages, the open threads),
 *              fits it under the per-call cost budget (`fitStressInput`, which
 *              says what was left out) and shows the call's "at most".
 *   START      `startStressTest` (`bible.edit`) refuses before anything is
 *              written when no call can be made (503 AI_UNAVAILABLE), no record
 *              this deployment accepts exists (503 STRESS_TEST_NOT_EVALUATED,
 *              D11), the book holds nothing (409 NOTHING_TO_TEST: rule 6), a
 *              test is already under way (409 STRESS_TEST_IN_PROGRESS), the call
 *              would pass its budget even cut down (409 CALL_OVER_BUDGET), or the
 *              author confirmed less than the "at most" now (409
 *              ESTIMATE_CHANGED); then queues the row and the `stress-test` job
 *              (payload ids only).
 *   RUN        `executeStressTest` (the job): the requester's standing is read
 *              again (one who left or may no longer edit stops it NO_ACTOR); the
 *              canon is read and fitted again, and a worst case past what the
 *              author confirmed stops it ESTIMATE_CHANGED (nothing sent); the
 *              kill switch, D11 and the model-call minute (waited out, never an
 *              uncharged call) are asked; ONE deep call; its weak points are
 *              validated (`validateWeakPoints`) and every citation checked again
 *              against the book as it stands (a gone row is dropped; a weak point
 *              left citing nothing is refused CITATION_GONE); written once.
 *              The ceiling, the kill switch and every failure end it with a named
 *              outcome and nothing claimed. AUDIT LAST.
 *   SESSION    the weak points' elements (`stressSessionElements`) are what an
 *              interview started from the test asks about (`interviews.ts`).
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { enqueue } from '@/app-layer/jobs/queue';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import { placedElementsOf, StoryThreadRepository } from '@/app-layer/repositories/continuity.repository';
import {
    canonCounts,
    citedRows,
    existingRefs,
    factSubjects,
    StressTestRepository,
    StressWeakPointRepository,
    type StressTestRow,
    type WeakPointRow,
} from '@/app-layer/repositories/interrogation.repository';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { WorkspaceRepository } from '@/app-layer/repositories/workspace.repository';
import { AiUnavailableError } from '@/lib/ai/errors';
import type { AuthorDataBlock } from '@/lib/ai/prompt';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { AppError, ConflictError, NotFoundError, ServiceUnavailableError } from '@/lib/errors/types';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import { fitStressInput, stressTestWorstCase } from '@/lib/stress-test/cost';
import { shownText, type ShownRef, type StressCoverage, type StressInputSources } from '@/lib/stress-test/input';
import { defaultStressTester, type StressTester } from '@/lib/stress-test/model-seam';
import { STRESS_TEST_CALL_COST_BUDGET_MICRO_USD, STRESS_TEST_PROMPT_VERSION } from '@/lib/stress-test/prompt';
import { stressTestGate, type StressTestGateVerdict } from '@/lib/stress-test/record-gate';
import { decodeWeakPointQuestions, sanitiseWeakPointForStorage } from '@/lib/stress-test/storage';
import { validateWeakPoints } from '@/lib/stress-test/validate';
import {
    STALE_STRESS_TEST_MS,
    STRESS_ELEMENTS_MAX,
    STRESS_SESSION_ELEMENTS_MAX,
    STRESS_TESTS_LISTED_MAX,
    WEAK_POINTS_MAX,
    isLiveStressTest,
    type CitationType,
    type StressTestOutcome,
    type StressTestStatus,
    type WeakPointKind,
} from '@/lib/stress-test/vocabulary';
import { decodeHeadingPath } from '@/lib/sources/storage';
import { defaultSleep, waitForModelRate } from './bible-facts';
import { requireBook } from './bible-common';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason } from './model-calls';
import { bookSourceSet } from './source-common';
import { assembleSourceContext } from './source-retrieval';

export interface StressTestDeps {
    tester?: (ctx: WorkspaceRequestContext) => StressTester;
    recordMode?: PackRecordMode;
    gate?: () => StressTestGateVerdict;
    enqueue?: (payload: { workspaceId: string; stressTestId: string }, jobId: string) => Promise<unknown>;
    charge?: (workspaceId: string, calls: number) => void;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    /** A call's worst case over its blocks (tests: a figure of their own). */
    worstCase?: (blocks: readonly AuthorDataBlock[]) => number;
    now?: () => Date;
}

/** Tokens the stress test asks the retriever for: facts and passages share it (the input's own budget cuts again). */
const STRESS_RETRIEVER_TOKEN_BUDGET = 6_000;
/** Placed elements read for the story order at most. */
const ORDER_READ_MAX = 400;
/** Weak points read for the page at most (every listed test's). */
const WEAK_POINTS_READ_MAX = STRESS_TESTS_LISTED_MAX * WEAK_POINTS_MAX;

const ORDER_NAME: Readonly<Record<string, string>> = { PLOT_BEAT: 'plot beats', TIMELINE_EVENT: 'timeline events' };

// ─── The canon ─────────────────────────────────────────────────────

/** What the book holds, in the input builder's terms (the header's ESTIMATE). */
export async function readStressCanon(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<{ sources: StressInputSources; sourceIds: string[] }> {
    const book = await requireBook(db, ctx, bookId);
    const elements = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { take: STRESS_ELEMENTS_MAX });
    const placed = await placedElementsOf(db, ctx.workspaceId, bookId, ORDER_READ_MAX);
    const positions = new Map<string, { order: string; position: number }>();
    const orders = new Map<string, string[]>();
    for (const e of placed) {
        const order = ORDER_NAME[e.kind] ?? 'story order';
        const list = orders.get(order) ?? [];
        list.push(e.id);
        orders.set(order, list);
        positions.set(e.id, { order, position: list.length });
    }
    const set = await bookSourceSet(db, ctx, bookId);
    const sourceIds = [...set.bookSourceIds, ...set.seriesSourceIds];
    // THE 4.1 RETRIEVER: the scope's facts (bible and confirmed source facts) and the most relevant passages, under its budget.
    const context = await assembleSourceContext(db, ctx, bookId, elements.map((e) => ({ elementId: e.id, kind: e.kind, name: e.name })), null, STRESS_RETRIEVER_TOKEN_BUDGET);
    const factIds = context.factIds ?? [];
    const passageIds = context.passageIds ?? [];
    const threads = await StoryThreadRepository.listOpen(db, ctx.workspaceId, bookId, 100);
    const totals = await canonCounts(db, ctx.workspaceId, bookId, sourceIds);
    return {
        sourceIds,
        sources: {
            book: { title: book.title, logline: book.logline ?? null },
            elements: elements.map((e) => ({ id: e.id, kind: e.kind, name: e.name, summary: e.summary, place: positions.get(e.id) ?? null })),
            facts: context.facts.map((f, i) => ({ id: factIds[i], subject: f.subject, statement: f.statement })).filter((f) => f.id !== undefined),
            threads: threads.map((t) => ({ id: t.id, kind: t.kind, title: t.title })),
            passages: context.passages.map((p, i) => ({ id: passageIds[i], headings: p.headings, text: p.text })).filter((p) => p.id !== undefined),
            orders: [...orders].map(([order, elementIds]) => ({ order, elementIds })),
            totals: { elements: totals.elements, facts: totals.facts, threads: totals.threads, passages: totals.passages },
        },
    };
}

// ─── Views ─────────────────────────────────────────────────────────

export interface WeakPointView {
    id: string;
    position: number;
    kind: WeakPointKind;
    title: string;
    questions: string[];
    citations: Array<{ type: CitationType; id: string; label: string | null }>;
    flags: string[];
}

export interface StressTestView {
    id: string;
    status: StressTestStatus;
    outcome: StressTestOutcome | null;
    createdAt: string;
    finishedAt: string | null;
    confirmedWorstMicroUsd: number;
    costMicroUsd: number;
    coverage: StressCoverage | null;
    weakPoints: WeakPointView[];
    /** What an interview started from this test asks about (empty: none can be started). */
    sessionElementIds: string[];
}

export interface StressTestPage {
    /** Rule 6: false for a book with nothing to read; the page says "not assessed". */
    assessed: boolean;
    estimate: { worstMicroUsd: number; coverage: StressCoverage | null; overBudget: boolean } | null;
    /** Why a test cannot be started here now (a code), or null. */
    unavailable: string | null;
    tests: StressTestView[];
    canEdit: boolean;
}

/** A live test with no sign of life for `STALE_STRESS_TEST_MS` reads STOPPED CLAIM_EXPIRED. */
export function effectiveTestState(row: Pick<StressTestRow, 'status' | 'outcome' | 'heartbeatAt'>, now: Date = new Date()): { status: StressTestStatus; outcome: StressTestOutcome | null } {
    if (isLiveStressTest(row.status) && now.getTime() - row.heartbeatAt.getTime() > STALE_STRESS_TEST_MS) return { status: 'STOPPED', outcome: 'CLAIM_EXPIRED' };
    return { status: row.status as StressTestStatus, outcome: (row.outcome as StressTestOutcome | null) ?? null };
}

function refsOf(row: WeakPointRow): ShownRef[] {
    return Array.isArray(row.citations) ? (row.citations as unknown[]).flatMap((c) => {
        const o = c as { type?: unknown; id?: unknown };
        return typeof o.type === 'string' && typeof o.id === 'string' ? [{ type: o.type as CitationType, id: o.id }] : [];
    }) : [];
}

/** Labels for cited rows (element names, fact subjects and statements, thread titles, passage headings). */
async function citationLabels(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, refs: readonly ShownRef[]): Promise<Map<string, string>> {
    const ids = (t: CitationType) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
    const out = new Map<string, string>();
    for (const e of await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, ids('ELEMENT'))) out.set(`ELEMENT:${e.id}`, e.name);
    const rows = await citedRows(db, ctx.workspaceId, bookId, { facts: ids('FACT'), threads: ids('THREAD'), passages: ids('PASSAGE') });
    for (const f of rows.facts) out.set(`FACT:${f.id}`, `${f.subjectName}: ${f.statement}`);
    for (const t of rows.threads) out.set(`THREAD:${t.id}`, t.title);
    for (const c of rows.passages) out.set(`PASSAGE:${c.id}`, decodeHeadingPath(c.headingPath).join(' › ') || '—');
    return out;
}

/**
 * The elements an interview started from these weak points asks about: each weak point's cited elements and the
 * subjects of its cited facts, in the weak points' order, at most `STRESS_SESSION_ELEMENTS_MAX`, the book's still.
 */
export async function stressSessionElements(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, rows: readonly WeakPointRow[]): Promise<string[]> {
    const refs = rows.flatMap(refsOf);
    const subjectOf = await factSubjects(db, ctx.workspaceId, [...new Set(refs.filter((r) => r.type === 'FACT').map((r) => r.id))]);
    const ordered: string[] = [];
    for (const r of refs) {
        const id = r.type === 'ELEMENT' ? r.id : r.type === 'FACT' ? subjectOf.get(r.id) : undefined;
        if (id && !ordered.includes(id)) ordered.push(id);
    }
    const standing = new Set((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, ordered)).map((e) => e.id));
    return ordered.filter((id) => standing.has(id)).slice(0, STRESS_SESSION_ELEMENTS_MAX);
}

async function testViews(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, rows: readonly StressTestRow[]): Promise<StressTestView[]> {
    const points = await StressWeakPointRepository.listForTests(db, ctx.workspaceId, rows.map((r) => r.id), WEAK_POINTS_READ_MAX);
    const labels = await citationLabels(db, ctx, bookId, points.flatMap(refsOf));
    const out: StressTestView[] = [];
    for (const r of rows) {
        const mine = points.filter((p) => p.stressTestId === r.id);
        const state = effectiveTestState(r);
        out.push({
            id: r.id,
            status: state.status,
            outcome: state.outcome,
            createdAt: r.createdAt.toISOString(),
            finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
            confirmedWorstMicroUsd: Number(r.confirmedWorstMicroUsd),
            costMicroUsd: Number(r.costMicroUsd),
            coverage: (r.coverage as unknown as StressCoverage | null) ?? null,
            weakPoints: mine.map((p) => ({
                id: p.id,
                position: p.position,
                kind: p.kind as WeakPointKind,
                title: p.title,
                questions: decodeWeakPointQuestions(p.questions),
                citations: refsOf(p).map((c) => ({ ...c, label: labels.get(`${c.type}:${c.id}`) ?? null })),
                flags: p.flags,
            })),
            sessionElementIds: mine.length > 0 ? await stressSessionElements(db, ctx, bookId, mine) : [],
        });
    }
    return out;
}

/** Why no test can be started in this deployment now, or null. */
function unavailableOf(deps: StressTestDeps): string | null {
    const reason = modelUnavailableReason();
    if (reason) return reason;
    const verdict = (deps.gate ?? (() => stressTestGate(deps.recordMode ?? deploymentPackRecordMode())))();
    return verdict.mounted ? null : 'STRESS_TEST_NOT_EVALUATED';
}

/** The Interrogate page's stress test half (`bible.view`): the estimate, and the book's tests newest first. */
export async function getStressTestPage(ctx: WorkspaceRequestContext, bookId: string, deps: StressTestDeps = {}): Promise<StressTestPage> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        const { sources } = await readStressCanon(db, ctx, bookId);
        const assessed = sources.elements.length > 0;
        const fitted = assessed ? fitStressInput(sources, deps.worstCase) : null;
        const rows = await StressTestRepository.listForBook(db, ctx.workspaceId, bookId, STRESS_TESTS_LISTED_MAX);
        return {
            assessed,
            estimate: fitted ? { worstMicroUsd: fitted.worstMicroUsd, coverage: fitted.ok ? fitted.coverage : null, overBudget: !fitted.ok } : null,
            unavailable: unavailableOf(deps),
            tests: await testViews(db, ctx, bookId, rows),
            canEdit: ctx.permissions.bible.edit,
        };
    });
}

/** One stress test (`bible.view`). */
export async function getStressTest(ctx: WorkspaceRequestContext, bookId: string, stressTestId: string): Promise<StressTestView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const row = await StressTestRepository.findInBook(db, ctx.workspaceId, bookId, stressTestId);
        if (!row) throw new NotFoundError('Stress test not found.');
        return (await testViews(db, ctx, bookId, [row]))[0];
    });
}

/** The weak points of a DONE test of the book, for an interview to start from (`interviews.ts`), or a 404 / 409. */
export async function requireStressTestForSession(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, stressTestId: string): Promise<{ rows: WeakPointRow[]; elementIds: string[] }> {
    const row = await StressTestRepository.findInBook(db, ctx.workspaceId, bookId, stressTestId);
    if (!row) throw new NotFoundError('Stress test not found.');
    const rows = await StressWeakPointRepository.listForTests(db, ctx.workspaceId, [row.id], WEAK_POINTS_MAX);
    if (row.status !== 'DONE' || rows.length === 0) throw new ConflictError('This stress test has no weak points to ask about.', { reason: 'STRESS_TEST_HAS_NO_WEAK_POINTS' });
    return { rows, elementIds: await stressSessionElements(db, ctx, bookId, rows) };
}

// ─── Start ─────────────────────────────────────────────────────────

/** Start a stress test (`bible.edit`; the refusals in the header). */
export async function startStressTest(ctx: WorkspaceRequestContext, bookId: string, input: { confirmWorstCaseMicroUsd: number }, deps: StressTestDeps = {}): Promise<StressTestView> {
    await assertPermission(ctx, 'bible.edit');
    await runInWorkspaceContext(ctx, (db) => requireBook(db, ctx, bookId));
    const reason = modelUnavailableReason();
    if (reason) throw new AiUnavailableError(reason);
    const verdict = (deps.gate ?? (() => stressTestGate(deps.recordMode ?? deploymentPackRecordMode())))();
    if (!verdict.mounted) throw new ServiceUnavailableError('The stress test is not available in this deployment yet.', { reason: 'STRESS_TEST_NOT_EVALUATED', gate: verdict.reason });
    const now = deps.now ?? (() => new Date());
    const created = await runInWorkspaceContext(
        ctx,
        async (db) => {
            // One live test a book: serialised per book, a stale one ended first.
            await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stress-test:${bookId}`}))`;
            const at = now();
            await StressTestRepository.expireStale(db, ctx.workspaceId, bookId, new Date(at.getTime() - STALE_STRESS_TEST_MS), at);
            if (await StressTestRepository.liveForBook(db, ctx.workspaceId, bookId, new Date(at.getTime() - STALE_STRESS_TEST_MS))) {
                throw new ConflictError('A stress test of this book is already under way.', { reason: 'STRESS_TEST_IN_PROGRESS' });
            }
            const { sources } = await readStressCanon(db, ctx, bookId);
            if (sources.elements.length === 0) throw new ConflictError('There is nothing in this book to test yet.', { reason: 'NOTHING_TO_TEST' });
            const fitted = fitStressInput(sources, deps.worstCase);
            if (!fitted.ok) throw new ConflictError('This book is too large for one stress test call within its budget.', { reason: 'CALL_OVER_BUDGET', worstCaseMicroUsd: fitted.worstMicroUsd, budgetMicroUsd: STRESS_TEST_CALL_COST_BUDGET_MICRO_USD });
            if (!Number.isFinite(input.confirmWorstCaseMicroUsd) || input.confirmWorstCaseMicroUsd < fitted.worstMicroUsd) {
                throw new ConflictError('The cost changed since it was shown; confirm the new amount.', { reason: 'ESTIMATE_CHANGED', worstCaseMicroUsd: fitted.worstMicroUsd });
            }
            const row = await StressTestRepository.create(db, ctx.workspaceId, { bookId, confirmedWorstMicroUsd: input.confirmWorstCaseMicroUsd, requestedById: ctx.userId, coverage: fitted.coverage as unknown as Prisma.InputJsonValue });
            // AUDIT LAST.
            await logEvent(ctx, { action: 'STRESS_TEST_REQUESTED', entityType: 'StressTest', entityId: row.id, details: { bookId, worstCaseMicroUsd: fitted.worstMicroUsd, elementsShown: fitted.coverage.elements.shown, cut: fitted.coverage.cut } }, { db });
            return row;
        },
        { timeout: 60_000 },
    );
    const payload = { workspaceId: ctx.workspaceId, stressTestId: created.id };
    try {
        await (deps.enqueue ?? ((p, j) => enqueue('stress-test', p, { jobId: j })))(payload, `stress-test-${created.id}`);
    } catch (err) {
        logger.error('stress_test.enqueue_failed', { component: 'stress-test', stressTestId: created.id, error: err instanceof AppError ? err.code : 'unknown' });
        await runInWorkspaceContext(ctx, (db) => StressTestRepository.finish(db, ctx.workspaceId, created.id, { status: 'FAILED', outcome: 'ENQUEUE_FAILED', from: ['QUEUED'], metrics: { errorCode: 'ENQUEUE_FAILED' }, at: now() }));
        throw err;
    }
    return getStressTest(ctx, bookId, created.id);
}

// ─── Run (the job) ─────────────────────────────────────────────────

const STATUS_OF: Readonly<Record<StressTestOutcome, Exclude<StressTestStatus, 'QUEUED' | 'RUNNING'>>> = {
    OK: 'DONE',
    NONE_FOUND: 'DONE',
    NOT_ASSESSED: 'DONE',
    CEILING: 'STOPPED',
    KILL_SWITCH: 'STOPPED',
    AI_UNAVAILABLE: 'STOPPED',
    NOT_EVALUATED: 'STOPPED',
    MODEL_RATE_LIMITED: 'STOPPED',
    ESTIMATE_CHANGED: 'STOPPED',
    CALL_OVER_BUDGET: 'STOPPED',
    ABORTED: 'STOPPED',
    CLAIM_EXPIRED: 'STOPPED',
    CALL_FAILED: 'STOPPED',
    GUARD_REFUSED: 'STOPPED',
    BOOK_DELETED: 'STOPPED',
    NO_ACTOR: 'STOPPED',
    ENQUEUE_FAILED: 'FAILED',
    INTERNAL: 'FAILED',
};

interface RunMetrics {
    refusals: Record<string, number>;
    callIds: string[];
    drafted: number;
    kept: number;
    errorCode?: string;
}

/** Run one stress test (the job's body; the header's RUN). */
export async function executeStressTest(payload: { workspaceId: string; stressTestId: string }, deps: StressTestDeps = {}): Promise<{ ran: boolean; outcome: StressTestOutcome | null }> {
    const now = deps.now ?? (() => new Date());
    const scope = { workspaceId: payload.workspaceId, requestId: randomUUID() };
    const metrics: RunMetrics = { refusals: {}, callIds: [], drafted: 0, kept: 0 };

    // 1. LOOK: the test, its book, the requester's standing now.
    const looked = await runInWorkspaceContext(scope, async (db) => {
        const test = await StressTestRepository.find(db, payload.workspaceId, payload.stressTestId);
        if (!test || test.status !== 'QUEUED') return null;
        if (!(await BookRepository.find(db, payload.workspaceId, test.bookId))) return { test, ctx: null, skip: 'BOOK_DELETED' as const };
        const slug = await WorkspaceRepository.findSlug(db, payload.workspaceId);
        const membership = test.requestedById ? await MembershipRepository.findForUser(db, payload.workspaceId, test.requestedById) : null;
        if (!slug || !membership || !test.requestedById || !getPermissionsForRole(membership.role).bible.edit) return { test, ctx: null, skip: 'NO_ACTOR' as const };
        const ctx: WorkspaceRequestContext = { requestId: scope.requestId, userId: test.requestedById, workspaceId: payload.workspaceId, workspaceSlug: slug, role: membership.role, permissions: getPermissionsForRole(membership.role) };
        return { test, ctx, skip: null };
    });
    if (!looked) return { ran: false, outcome: null };
    const { test } = looked;
    const finish = async (outcome: StressTestOutcome, claim: Date | undefined, extra: { coverage?: StressCoverage; called?: boolean } = {}) => {
        await runInWorkspaceContext(looked.ctx ?? scope, async (db) => {
            const done = await StressTestRepository.finish(db, payload.workspaceId, test.id, {
                status: STATUS_OF[outcome],
                outcome,
                from: claim ? ['RUNNING'] : ['QUEUED'],
                claim,
                ...(extra.coverage ? { coverage: extra.coverage as unknown as Prisma.InputJsonValue } : {}),
                promptVersion: extra.called ? STRESS_TEST_PROMPT_VERSION : undefined,
                metrics: metrics as unknown as Prisma.InputJsonValue,
                at: now(),
            });
            if (done && looked.ctx) {
                // AUDIT LAST (3.H).
                await logEvent(looked.ctx, { action: 'STRESS_TEST_FINISHED', entityType: 'StressTest', entityId: test.id, details: { bookId: test.bookId, outcome, kept: metrics.kept, drafted: metrics.drafted } }, { db, actorType: 'SYSTEM' });
            }
        });
        return { ran: true, outcome };
    };
    if (looked.skip || !looked.ctx) return finish(looked.skip ?? 'NO_ACTOR', undefined);
    const ctx = looked.ctx;

    // 2. CLAIM.
    const claim = now();
    const claimed = await runInWorkspaceContext(ctx, (db) => StressTestRepository.claim(db, ctx.workspaceId, test.id, claim));
    if (!claimed) return { ran: false, outcome: null };

    try {
        // 3. The canon, read and fitted again (the book may have moved since the author confirmed).
        const canon = await runInWorkspaceContext(ctx, (db) => readStressCanon(db, ctx, test.bookId));
        if (canon.sources.elements.length === 0) return await finish('NOT_ASSESSED', claim);
        const unavailable = modelUnavailableReason();
        if (unavailable) {
            metrics.errorCode = unavailable;
            return await finish(unavailable === 'AI_DISABLED' ? 'KILL_SWITCH' : 'AI_UNAVAILABLE', claim);
        }
        const verdict = (deps.gate ?? (() => stressTestGate(deps.recordMode ?? deploymentPackRecordMode())))();
        if (!verdict.mounted) {
            metrics.errorCode = verdict.reason;
            return await finish('NOT_EVALUATED', claim);
        }
        const fitted = fitStressInput(canon.sources, deps.worstCase ?? ((b) => stressTestWorstCase(b)));
        if (!fitted.ok) return await finish('CALL_OVER_BUDGET', claim);
        // The job's budget is what the author confirmed: a call that could cost more is never sent.
        if (fitted.worstMicroUsd > Number(test.confirmedWorstMicroUsd)) return await finish('ESTIMATE_CHANGED', claim, { coverage: fitted.coverage });
        if (deps.signal?.aborted) return await finish('ABORTED', claim, { coverage: fitted.coverage });
        if (!(await waitForModelRate(ctx, deps.charge ?? chargeModelCalls, deps.sleep ?? defaultSleep, deps.signal))) {
            return await finish(deps.signal?.aborted ? 'ABORTED' : 'MODEL_RATE_LIMITED', claim, { coverage: fitted.coverage });
        }
        await runInWorkspaceContext(ctx, (db) => StressTestRepository.heartbeat(db, ctx.workspaceId, test.id, claim, now()));

        // 4. THE CALL (outside every transaction).
        const tester = (deps.tester ?? ((c: WorkspaceRequestContext) => defaultStressTester(c)))(ctx);
        const result = await tester.extract({ data: fitted.blocks, bookId: test.bookId }, deps.signal);
        metrics.callIds.push(...result.callIds);
        await runInWorkspaceContext(ctx, (db) => StressTestRepository.addCost(db, ctx.workspaceId, test.id, result.costMicroUsd));
        if (!result.ok) {
            metrics.errorCode = result.errorCode;
            const outcome: StressTestOutcome =
                result.failure === 'KILL_SWITCH' ? 'KILL_SWITCH'
                : result.failure === 'WORKSPACE_CEILING' ? 'CEILING'
                : result.failure === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE'
                : result.failure === 'ABORTED' ? 'ABORTED'
                : result.failure === 'GUARD_REFUSED' ? 'GUARD_REFUSED'
                : 'CALL_FAILED';
            return await finish(outcome, claim, { coverage: fitted.coverage, called: true });
        }

        // 5. VALIDATE, then check every citation against the book as it stands, and write once.
        const v = validateWeakPoints(result.output, { shown: fitted.shown, text: shownText(fitted) });
        metrics.drafted = v.drafted;
        for (const [code, n] of Object.entries(v.refusals)) metrics.refusals[code] = (metrics.refusals[code] ?? 0) + (n ?? 0);
        const kept = await runInWorkspaceContext(ctx, async (db) => {
            const standing = await existingRefs(db, ctx.workspaceId, test.bookId, v.weakPoints.flatMap((w) => w.citations), canon.sourceIds);
            const rows: Array<{ position: number; kind: string; title: string; questions: string; citations: Prisma.InputJsonValue; flags: string[] }> = [];
            for (const w of v.weakPoints) {
                const citations = w.citations.filter((c) => standing.has(`${c.type}:${c.id}`));
                if (citations.length === 0) {
                    metrics.refusals.CITATION_GONE = (metrics.refusals.CITATION_GONE ?? 0) + 1;
                    continue;
                }
                const stored = sanitiseWeakPointForStorage({ title: w.title, questions: w.questions });
                rows.push({ position: rows.length + 1, kind: w.kind, title: stored.title, questions: stored.questions, citations: citations.map((c) => ({ type: c.type, id: c.id })), flags: [...w.flags] });
            }
            return StressWeakPointRepository.createMany(db, ctx.workspaceId, test.id, rows);
        });
        metrics.kept = kept;
        return await finish(kept > 0 ? 'OK' : 'NONE_FOUND', claim, { coverage: fitted.coverage, called: true });
    } catch (err) {
        logger.error('stress_test.failed', { component: 'stress-test', stressTestId: test.id, error: err instanceof Error ? err.name : 'unknown' });
        metrics.errorCode = 'INTERNAL';
        return finish('INTERNAL', claim);
    }
}
