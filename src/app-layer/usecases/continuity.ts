/**
 * THE CONTINUITY PAGE'S USECASES (Phase 4.2, D28). `bible.view` reads,
 * `bible.edit` decides and edits. Nothing here calls a model or writes the
 * bible (rule 1): it reads what the checks proposed and records the author's
 * decisions.
 *
 *   read        `getContinuityPage`: whether the book has anything to check
 *               (rule 6: no live fact is "not assessed", never "no
 *               contradictions"), the pending contradictions with both facts
 *               and their sources, the facts their entries no longer state, the
 *               threads (promises, clues, open questions) and the threads
 *               proposed, the "decide later" answers still open, the entries
 *               that may be stale, and when the nightly check last ran and what
 *               it covered. Every list is bounded and says when it was cut.
 *   threads     `createThread`, `updateThread`, `deleteThread`: by hand, under
 *               the book's thread lock (`story-threads:<bookId>`, taken alone),
 *               an edit naming the version it was made against (409
 *               VERSION_CONFLICT), a state the kind allows (400
 *               STATE_NOT_ALLOWED), an element of the book (404). At most
 *               `THREADS_PER_BOOK_MAX` (409 THREADS_FULL). Audit last.
 *   proposals   `decideThreadProposal`: ACCEPT a new thread (created OPEN, the
 *               proposal naming it) or a pay-off (the thread, still OPEN, moved
 *               to its closed state; 409 THREAD_NOT_OPEN otherwise, and the
 *               thread's other pending pay-offs settled), or REJECT. Once (409
 *               PROPOSAL_DECIDED). A flagged proposal (D14) is decided like any
 *               other, one by one: there is no bulk accept.
 *   stale       `dismissStaleFlag`: the author says the entry still holds.
 *   settings    `getContinuitySettings` / `saveContinuitySettings` (D35 addendum A): whether the nightly deep check
 *               also reads the book's draft facts — off until the author turns it on (`bible.edit`; read with
 *               `bible.view`), audited with ids and codes only.
 *
 * Contradictions are decided by `decideFactProposal` (`fact-proposals.ts`, 4.1's
 * record extended): keep the newer, keep the older, both true (explained), or
 * not a contradiction.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import {
    ContinuityCheckRepository,
    ContinuityFactRepository,
    ContinuityRunRepository,
    ContinuitySettingsRepository,
    decideLaterAnswersOf,
    StaleFlagRepository,
    StoryThreadProposalRepository,
    StoryThreadRepository,
    type StoryThreadRow,
} from '@/app-layer/repositories/continuity.repository';
import { BibleVersionReadRepository, FactBackfillRepository, FactProposalRepository } from '@/app-layer/repositories/fact-layer.repository';
import { ContinuitySettingsInput, ContinuityThreadInput, ContinuityThreadUpdateInput, ThreadProposalDecisionInput } from '@/app-layer/schemas/continuity';
import { VersionNumberParam } from '@/app-layer/schemas/bible';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { sanitiseThreadForStorage } from '@/lib/continuity/storage';
import { CONTINUITY_LIST_MAX, threadStateAllowed, THREADS_PER_BOOK_MAX, type ContinuityOutcome, type ThreadKind } from '@/lib/continuity/vocabulary';
import { requireBook } from './bible-common';
import { storedTextOf } from './interview-state';
import { views, type FactProposalView } from './fact-proposals';
import { standingStaleFlags } from './stale-flags';
import { DraftMismatchRepository, DraftReadRunRepository, SceneDraftReadRepository, scenesInOrder, ThreadSceneLinkRepository } from '@/app-layer/repositories/draft-facts.repository';
import { compareSceneOrder, isUnpaidSetup } from '@/lib/draft-facts/threads';
import {
    DRAFT_LIST_MAX,
    OPEN_DRAFT_STATUSES,
    RECENTLY_RESOLVED_DAYS,
    RECENTLY_RESOLVED_MAX,
    type DraftMismatchView,
    type DraftReadingView,
    type DraftReadOutcome,
    type SceneLinkView,
} from '@/lib/draft-facts/vocabulary';
import { draftMismatchViews, threadLinkViews } from './draft-mismatches';

export interface ThreadView {
    id: string;
    kind: ThreadKind;
    title: string;
    note: string | null;
    state: string;
    subjectElementId: string | null;
    subjectName: string | null;
    version: number;
    updatedAt: string;
    /** Phase 5.3 (D35 item 4): the scenes confirmed to plant it and to pay it off, in manuscript order. */
    plantedIn: Array<{ sceneId: string; sceneTitle: string | null }>;
    paidIn: Array<{ sceneId: string; sceneTitle: string | null }>;
    /** An open promise or clue planted in a scene and paid off by none after it, to the book's end. */
    unpaidSetup: boolean;
}

export interface ThreadProposalView {
    id: string;
    op: 'NEW_THREAD' | 'SET_STATE';
    kind: ThreadKind;
    title: string | null;
    proposedState: string;
    /** A pay-off's thread (its title), or the thread an accepted proposal made. */
    threadId: string | null;
    threadTitle: string | null;
    quote: string;
    /** Where it comes from: the element and the version it cites. */
    elementName: string | null;
    versionNumber: number | null;
    flags: string[];
    createdAt: string;
}

/** Relations read to tell whether a "decide later" pair has been related since (4.H-a). */
const DECIDE_LATER_PAIR_RELATIONS_READ = 500;

export interface DecideLaterView {
    answerId: string;
    sessionId: string;
    elementId: string;
    elementName: string | null;
    /**
     * 4.H-a (#66 item 5): a question about a PAIR with no relation yet (4.4's relations generator) names the pair —
     * this is its second element — and is open while the two still hold no relation; it carries no field of either
     * element (`fieldKeys` is empty).
     */
    pair: { elementId: string; elementName: string | null } | null;
    fieldKeys: string[];
    question: string;
    answeredAt: string;
}

export interface StaleFlagView {
    id: string;
    elementId: string;
    elementName: string | null;
    upstreamElementId: string;
    upstreamName: string | null;
    /** The upstream versions the change runs between (the first, absent for a first version; and the newest). */
    fromVersion: number | null;
    toVersion: number | null;
    raisedAt: string;
}

export interface ContinuityPage {
    /** Rule 6: false when the book holds no live fact — nothing was checked, so nothing is reported clean. */
    assessed: boolean;
    liveFacts: number;
    contradictions: { items: FactProposalView[]; pending: number; truncated: boolean };
    noLongerStated: { items: FactProposalView[]; pending: number; truncated: boolean };
    threads: { items: ThreadView[]; truncated: boolean };
    threadProposals: { items: ThreadProposalView[]; pending: number; truncated: boolean };
    decideLater: { items: DecideLaterView[]; truncated: boolean };
    stale: { items: StaleFlagView[]; truncated: boolean };
    nightly: {
        lastRunAt: string | null;
        outcome: ContinuityOutcome | null;
        subjectsCovered: number;
        subjectsRemaining: number;
        factsRead: number;
        /** Every live fact created at or before this has been checked by a complete pass; null: never. */
        coveredThrough: string | null;
        /** A pass is under way (it goes on the next night). */
        passUnderWay: boolean;
        /**
         * 4.H-a (#62 item 1): the last run read only the first `CONTINUITY_FACTS_READ_MAX` of the book's live facts — the
         * rest were not checked, so no pass over this book is ever reported complete while it holds more.
         */
        factsCut: boolean;
        /** 4.H-a (#62 item 3): subjects of the pass (or the last complete one) passed over unchecked: a page that failed night after night, or one the guard refused. */
        parkedSubjects: number;
        /**
         * 4.H-b (D32): subjects passed over and not checked since — remembered, retried in the next pass — and whether
         * more were than the check remembers (the next pass then checks every subject).
         */
        passedOverOutstanding: number;
        passedOverCut: boolean;
        /** Every live fact checked: a complete pass, nothing cut, nothing passed over or outstanding (rule 6: never claimed otherwise). */
        complete: boolean;
    };
    /**
     * 4.H-b (D31, D32): the background reading of entries saved before 4.1 — `read` of `total` read so far, `notRead`
     * that could not be (no member may act for them, or their attempts ran out), the rest waiting. `total` 0: the book
     * has no such entries, and nothing is claimed about them (rule 6).
     */
    backfill: { total: number; read: number; notRead: number; waiting: number };
    /**
     * Phase 5.3 (D35): the draft held against the bible — the nightly reading's state (rule 6: a manuscript never read
     * is "not read yet", never "no mismatches"), the open draft mismatches, and the thread links proposed.
     */
    draft: {
        reading: DraftReadingView;
        mismatches: { items: DraftMismatchView[]; open: number; truncated: boolean };
        linkProposals: { items: SceneLinkView[]; pending: number; truncated: boolean };
        /**
         * D35 addendum C: mismatches that settled BY THEMSELVES in the last `days` days (the database's clock) — the
         * draft no longer makes the claim, or the bible fact went —, newest first. Empty says only that nothing settled
         * so lately, never that the draft agrees with the bible (rule 6).
         */
        recentlyResolved: { items: DraftMismatchView[]; days: number; truncated: boolean };
    };
    /** D35 addendum A: the book's continuity settings (the defaults when the author has saved none). */
    settings: ContinuitySettingsView;
}

/** D35 addendum A: a book's continuity settings as the page and the settings route show them. */
export interface ContinuitySettingsView {
    /** The nightly deep check also reads the book's draft facts (off by default; it spends the same nightly share). */
    deepReadsDraft: boolean;
}

const NO_LINKS: Pick<ThreadView, 'plantedIn' | 'paidIn' | 'unpaidSetup'> = { plantedIn: [], paidIn: [], unpaidSetup: false };

function threadView(t: StoryThreadRow, names: Map<string, string>, links: Pick<ThreadView, 'plantedIn' | 'paidIn' | 'unpaidSetup'> = NO_LINKS): ThreadView {
    return {
        ...links,
        id: t.id,
        kind: t.kind as ThreadKind,
        title: t.title,
        note: t.note,
        state: t.state,
        subjectElementId: t.subjectElementId,
        subjectName: t.subjectElementId ? (names.get(t.subjectElementId) ?? null) : null,
        version: t.version,
        updatedAt: t.updatedAt.toISOString(),
    };
}

/** The Continuity page's read (the header). */
export async function getContinuityPage(ctx: WorkspaceRequestContext, bookId: string): Promise<ContinuityPage> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const liveFacts = await ContinuityFactRepository.countLiveBibleFacts(db, ctx.workspaceId, bookId);
        const counts = await FactProposalRepository.countPendingByReason(db, ctx.workspaceId, bookId);
        const contradicted = await FactProposalRepository.listPendingByReason(db, ctx.workspaceId, bookId, 'CONTRADICTED', CONTINUITY_LIST_MAX + 1);
        const gone = await FactProposalRepository.listPendingByReason(db, ctx.workspaceId, bookId, 'NO_LONGER_STATED', CONTINUITY_LIST_MAX + 1);

        const threadRows = await StoryThreadRepository.list(db, ctx.workspaceId, bookId, CONTINUITY_LIST_MAX + 1);
        const proposalRows = await StoryThreadProposalRepository.listPending(db, ctx.workspaceId, bookId, CONTINUITY_LIST_MAX + 1);
        const proposalsPending = await StoryThreadProposalRepository.countPending(db, ctx.workspaceId, bookId);
        const later = await decideLaterAnswersOf(db, ctx.workspaceId, bookId, CONTINUITY_LIST_MAX + 1);
        const flagRows = await StaleFlagRepository.listOpen(db, ctx.workspaceId, bookId, CONTINUITY_LIST_MAX + 1);
        const { standing } = await standingStaleFlags(db, ctx.workspaceId, flagRows.slice(0, CONTINUITY_LIST_MAX));

        // Names of every element the lists mention, in one read.
        const threadsShown = threadRows.slice(0, CONTINUITY_LIST_MAX);
        const proposalsShown = proposalRows.slice(0, CONTINUITY_LIST_MAX);
        const elementIds = [
            ...threadsShown.map((t) => t.subjectElementId),
            ...proposalsShown.map((p) => p.subjectElementId),
            ...later.rows.flatMap((r) => [r.question.elementId, r.question.pairElementId]),
            ...standing.flatMap((f) => [f.elementId, f.upstreamElementId]),
        ].filter((x): x is string => !!x);
        const names = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, [...new Set(elementIds)])).map((e) => [e.id, e.name] as const));

        // Thread proposals: the version each cites, and a pay-off's thread.
        const versionNumbers = await BibleVersionReadRepository.elementVersionNumbers(db, ctx.workspaceId, [
            ...proposalsShown.map((p) => p.bibleVersionId),
            ...standing.flatMap((f) => [f.baseVersionId, f.upstreamVersionId]),
        ].filter((x): x is string => !!x));
        // 4.H-b (#62.2): a standing flag is not rewritten by each later save of its upstream entry, so the change it shows
        // runs to the upstream's newest version, read here, not to the version that opened it.
        const upstreamNewest = await StaleFlagRepository.newestContentVersions(db, ctx.workspaceId, [...new Set(standing.map((f) => f.upstreamElementId))]);
        const threadTitles = new Map(threadRows.map((t) => [t.id, t.title] as const));
        for (const p of proposalsShown) {
            if (p.threadId && !threadTitles.has(p.threadId)) {
                const t = await StoryThreadRepository.find(db, ctx.workspaceId, bookId, p.threadId);
                if (t) threadTitles.set(t.id, t.title);
            }
        }

        // "Decide later": a question whose latest answer is still DECIDE_LATER, and whose fields the bible still lacks.
        const latest = new Map<string, number>();
        for (const r of later.revisions) latest.set(r.questionId, Math.max(latest.get(r.questionId) ?? 0, r.revision));
        const open = later.rows.slice(0, CONTINUITY_LIST_MAX).filter((r) => latest.get(r.questionId) === r.revision && !r.question.relationId);
        const stored = await storedTextOf(db, ctx, [...new Set(open.filter((r) => !r.question.pairElementId).map((r) => r.question.elementId))]);
        // A pair question (4.H-a, #66 item 5) is open while its two elements still hold no relation: its fields are the
        // relation's to come, never the first element's.
        const pairIds = [...new Set(open.flatMap((r) => (r.question.pairElementId ? [r.question.elementId, r.question.pairElementId] : [])))];
        const related = new Set<string>();
        if (pairIds.length > 0) for (const rel of await BibleRelationRepository.listBetween(db, ctx.workspaceId, bookId, pairIds, DECIDE_LATER_PAIR_RELATIONS_READ)) related.add([rel.fromElementId, rel.toElementId].sort().join('\u0000'));
        const stillOpen = (r: (typeof open)[number]): boolean => {
            const q = r.question;
            if (q.pairElementId) return names.has(q.elementId) && names.has(q.pairElementId) && !related.has([q.elementId, q.pairElementId].sort().join('\u0000'));
            return q.targetsFieldKeys.some((k) => !stored.get(q.elementId)?.has(k));
        };
        const decideLater: DecideLaterView[] = open
            .filter(stillOpen)
            .map((r) => ({
                answerId: r.id,
                sessionId: r.sessionId,
                elementId: r.question.elementId,
                elementName: names.get(r.question.elementId) ?? null,
                pair: r.question.pairElementId ? { elementId: r.question.pairElementId, elementName: names.get(r.question.pairElementId) ?? null } : null,
                fieldKeys: r.question.pairElementId ? [] : r.question.targetsFieldKeys,
                question: r.question.text,
                answeredAt: r.createdAt.toISOString(),
            }));

        // Phase 5.3: the threads' confirmed scene links (one read for the shown threads), in manuscript order.
        const confirmed = await ThreadSceneLinkRepository.confirmedForThreads(db, ctx.workspaceId, bookId, threadsShown.map((t) => t.id), CONTINUITY_LIST_MAX * 10);
        const linkProposalRows = await ThreadSceneLinkRepository.forBook(db, ctx.workspaceId, bookId, ['PENDING'], DRAFT_LIST_MAX + 1);
        const mismatchRows = await DraftMismatchRepository.forBook(db, ctx.workspaceId, bookId, OPEN_DRAFT_STATUSES, DRAFT_LIST_MAX + 1);
        const linkedScenes = new Map((await scenesInOrder(db, ctx.workspaceId, bookId, [...new Set(confirmed.map((l) => l.sceneId))])).map((sc) => [sc.id, sc] as const));
        const linksOf = (threadId: string, thread: StoryThreadRow): Pick<ThreadView, 'plantedIn' | 'paidIn' | 'unpaidSetup'> => {
            const mine = confirmed.filter((l) => l.threadId === threadId).map((l) => {
                const sc = linkedScenes.get(l.sceneId);
                return { role: l.role, sceneId: l.sceneId, sceneTitle: sc?.title ?? null, order: sc ? { partRank: sc.chapter.part.rank, chapterRank: sc.chapter.rank, sceneRank: sc.rank } : null };
            });
            const ordered = [...mine].sort((a, b) => (a.order && b.order ? compareSceneOrder(a.order, b.order) : a.order ? -1 : b.order ? 1 : 0));
            return {
                plantedIn: ordered.filter((l) => l.role === 'PLANTS').map((l) => ({ sceneId: l.sceneId, sceneTitle: l.sceneTitle })),
                paidIn: ordered.filter((l) => l.role === 'PAYS').map((l) => ({ sceneId: l.sceneId, sceneTitle: l.sceneTitle })),
                unpaidSetup: isUnpaidSetup(thread, mine),
            };
        };
        const resolvedRows = await DraftMismatchRepository.recentlySettled(db, ctx.workspaceId, bookId, RECENTLY_RESOLVED_DAYS, RECENTLY_RESOLVED_MAX + 1);
        const settings = await ContinuitySettingsRepository.find(db, ctx.workspaceId, bookId);
        const reading = await SceneDraftReadRepository.progressForBook(db, ctx.workspaceId, bookId);
        const lastRead = await DraftReadRunRepository.lastFinished(db, ctx.workspaceId, bookId);

        const check = await ContinuityCheckRepository.find(db, ctx.workspaceId, bookId);
        const last = await ContinuityRunRepository.lastFinished(db, ctx.workspaceId, bookId);
        const backfill = await FactBackfillRepository.progressForBook(db, ctx.workspaceId, bookId);
        // 4.H-a (#62 item 1): a run that read a cut set of facts says so (its metrics), and so does the page.
        const factsCut = !!last && typeof last.metrics === 'object' && last.metrics !== null && (last.metrics as { factsCut?: unknown }).factsCut === true;
        return {
            assessed: liveFacts > 0,
            liveFacts,
            contradictions: { items: await views(db, ctx, bookId, contradicted.slice(0, CONTINUITY_LIST_MAX)), pending: counts.contradicted, truncated: contradicted.length > CONTINUITY_LIST_MAX },
            noLongerStated: { items: await views(db, ctx, bookId, gone.slice(0, CONTINUITY_LIST_MAX)), pending: counts.noLongerStated, truncated: gone.length > CONTINUITY_LIST_MAX },
            threads: { items: threadsShown.map((t) => threadView(t, names, linksOf(t.id, t))), truncated: threadRows.length > CONTINUITY_LIST_MAX },
            threadProposals: {
                items: proposalsShown.map((p) => ({
                    id: p.id,
                    op: p.op as 'NEW_THREAD' | 'SET_STATE',
                    kind: p.kind as ThreadKind,
                    title: p.title,
                    proposedState: p.proposedState,
                    threadId: p.threadId,
                    threadTitle: p.threadId ? (threadTitles.get(p.threadId) ?? null) : null,
                    quote: p.quote,
                    elementName: p.subjectElementId ? (names.get(p.subjectElementId) ?? null) : null,
                    versionNumber: p.bibleVersionId ? (versionNumbers.get(p.bibleVersionId) ?? null) : null,
                    flags: p.flags,
                    createdAt: p.createdAt.toISOString(),
                })),
                pending: proposalsPending,
                truncated: proposalRows.length > CONTINUITY_LIST_MAX,
            },
            decideLater: { items: decideLater, truncated: later.rows.length > CONTINUITY_LIST_MAX },
            stale: {
                items: standing.map((f) => ({
                    id: f.id,
                    elementId: f.elementId,
                    elementName: names.get(f.elementId) ?? null,
                    upstreamElementId: f.upstreamElementId,
                    upstreamName: names.get(f.upstreamElementId) ?? null,
                    fromVersion: f.baseVersionId ? (versionNumbers.get(f.baseVersionId) ?? null) : null,
                    toVersion: upstreamNewest.get(f.upstreamElementId) ?? versionNumbers.get(f.upstreamVersionId) ?? null,
                    raisedAt: f.raisedAt.toISOString(),
                })),
                truncated: flagRows.length > CONTINUITY_LIST_MAX,
            },
            nightly: {
                lastRunAt: last?.finishedAt?.toISOString() ?? null,
                outcome: (last?.outcome as ContinuityOutcome | null) ?? null,
                subjectsCovered: last?.subjectsCovered ?? 0,
                subjectsRemaining: last?.subjectsRemaining ?? 0,
                factsRead: last?.factsRead ?? 0,
                coveredThrough: check?.coveredThrough?.toISOString() ?? null,
                passUnderWay: !!check?.passTarget,
                factsCut,
                parkedSubjects: check?.parkedSubjects ?? 0,
                passedOverOutstanding: check?.passedOver.length ?? 0,
                passedOverCut: check?.passedOverCut ?? false,
                complete:
                    !!check?.coveredThrough &&
                    !check.passTarget &&
                    !factsCut &&
                    (check.parkedSubjects ?? 0) === 0 &&
                    check.passedOver.length === 0 &&
                    !check.passedOverCut &&
                    liveFacts > 0,
            },
            backfill: { total: backfill.queued + backfill.waiting, read: backfill.read, notRead: backfill.notRead, waiting: backfill.queued + backfill.waiting - backfill.read - backfill.notRead },
            draft: {
                reading: {
                    scenesWithText: reading.withText,
                    scenesRead: reading.read,
                    scenesWaiting: reading.waiting,
                    scenesPassedOver: reading.passedOver,
                    lastRunAt: lastRead?.finishedAt?.toISOString() ?? null,
                    lastOutcome: (lastRead?.outcome as DraftReadOutcome | null) ?? null,
                },
                mismatches: {
                    items: await draftMismatchViews(db, ctx, bookId, mismatchRows.slice(0, DRAFT_LIST_MAX)),
                    open: await DraftMismatchRepository.countForBook(db, ctx.workspaceId, bookId, OPEN_DRAFT_STATUSES),
                    truncated: mismatchRows.length > DRAFT_LIST_MAX,
                },
                linkProposals: {
                    items: await threadLinkViews(db, ctx, bookId, linkProposalRows.slice(0, DRAFT_LIST_MAX)),
                    pending: await ThreadSceneLinkRepository.countForBook(db, ctx.workspaceId, bookId, ['PENDING']),
                    truncated: linkProposalRows.length > DRAFT_LIST_MAX,
                },
                recentlyResolved: {
                    items: await draftMismatchViews(db, ctx, bookId, resolvedRows.slice(0, RECENTLY_RESOLVED_MAX)),
                    days: RECENTLY_RESOLVED_DAYS,
                    truncated: resolvedRows.length > RECENTLY_RESOLVED_MAX,
                },
            },
            settings: { deepReadsDraft: settings?.deepReadsDraft ?? false },
        };
    });
}

async function lockThreads(db: PrismaTx, bookId: string): Promise<void> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'story-threads:' + bookId}))`;
}

async function requireSubject(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elementId: string | null | undefined): Promise<string | null> {
    if (!elementId) return null;
    const [e] = await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, [elementId]);
    if (!e) throw new NotFoundError('Element not found.');
    return e.id;
}

/** A thread added by hand (the header). */
export async function createThread(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<ThreadView> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const parsed = ContinuityThreadInput.parse(input);
        const state = parsed.state ?? 'OPEN';
        if (!threadStateAllowed(parsed.kind, state)) throw new ValidationError('That state does not fit this kind of thread.', { reason: 'STATE_NOT_ALLOWED' });
        const clean = sanitiseThreadForStorage({ title: parsed.title, note: parsed.note ?? null });
        await lockThreads(db, bookId);
        const subject = await requireSubject(db, ctx, bookId, parsed.subjectElementId);
        if ((await StoryThreadRepository.count(db, ctx.workspaceId, bookId)) >= THREADS_PER_BOOK_MAX) throw new ConflictError('This book holds as many threads as it can.', { reason: 'THREADS_FULL', max: THREADS_PER_BOOK_MAX });
        const row = await StoryThreadRepository.create(db, ctx.workspaceId, { bookId, kind: parsed.kind, title: clean.title, note: clean.note, state, subjectElementId: subject, createdById: ctx.userId });
        await logEvent(ctx, { action: 'STORY_THREAD_CREATED', entityType: 'StoryThread', entityId: row.id, details: { bookId, kind: parsed.kind, state, origin: 'AUTHOR' } }, { db });
        return threadView(row, new Map());
    });
}

/** A thread edited by hand: its title, note, state or element, against the version the author saw. */
export async function updateThread(ctx: WorkspaceRequestContext, bookId: string, threadId: string, input: unknown): Promise<ThreadView> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const parsed = ContinuityThreadUpdateInput.parse(input);
        await lockThreads(db, bookId);
        const current = await StoryThreadRepository.find(db, ctx.workspaceId, bookId, threadId);
        if (!current) throw new NotFoundError('Thread not found.');
        if (current.version !== parsed.baseVersion) throw new ConflictError('This thread changed since you opened it.', { reason: 'VERSION_CONFLICT', currentVersion: current.version });
        const state = parsed.state ?? current.state;
        if (!threadStateAllowed(current.kind, state)) throw new ValidationError('That state does not fit this kind of thread.', { reason: 'STATE_NOT_ALLOWED' });
        const clean = sanitiseThreadForStorage({ title: parsed.title ?? current.title, note: parsed.note === undefined ? current.note : parsed.note });
        const subject = parsed.subjectElementId === undefined ? current.subjectElementId : await requireSubject(db, ctx, bookId, parsed.subjectElementId);
        if (!(await StoryThreadRepository.update(db, ctx.workspaceId, threadId, parsed.baseVersion, { title: clean.title, note: clean.note, state, subjectElementId: subject, updatedById: ctx.userId }))) {
            throw new ConflictError('This thread changed since you opened it.', { reason: 'VERSION_CONFLICT' });
        }
        const row = (await StoryThreadRepository.find(db, ctx.workspaceId, bookId, threadId))!;
        await logEvent(ctx, { action: 'STORY_THREAD_UPDATED', entityType: 'StoryThread', entityId: threadId, details: { bookId, kind: current.kind, state, stateChanged: state !== current.state, version: row.version } }, { db });
        return threadView(row, new Map());
    });
}

/** A thread removed by hand (the proposals that named it keep their history, the pointer cleared). */
export async function deleteThread(ctx: WorkspaceRequestContext, bookId: string, threadId: string, baseVersionParam: unknown): Promise<{ id: string }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const parsed = { baseVersion: VersionNumberParam.parse(baseVersionParam) };
        await lockThreads(db, bookId);
        const current = await StoryThreadRepository.find(db, ctx.workspaceId, bookId, threadId);
        if (!current) throw new NotFoundError('Thread not found.');
        if (!(await StoryThreadRepository.remove(db, ctx.workspaceId, threadId, parsed.baseVersion))) {
            throw new ConflictError('This thread changed since you opened it.', { reason: 'VERSION_CONFLICT', currentVersion: current.version });
        }
        await logEvent(ctx, { action: 'STORY_THREAD_DELETED', entityType: 'StoryThread', entityId: threadId, details: { bookId, kind: current.kind } }, { db });
        return { id: threadId };
    });
}

/** Accept or reject a thread the product proposed (the header). */
export async function decideThreadProposal(ctx: WorkspaceRequestContext, bookId: string, proposalId: string, input: unknown): Promise<{ id: string; status: string; threadId: string | null }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const { decision } = ThreadProposalDecisionInput.parse(input);
        await lockThreads(db, bookId);
        const p = await StoryThreadProposalRepository.find(db, ctx.workspaceId, bookId, proposalId);
        if (!p) throw new NotFoundError('Proposal not found.');
        if (p.status !== 'PENDING') throw new ConflictError('This proposal was already decided.', { reason: 'PROPOSAL_DECIDED', status: p.status });
        const at = new Date();
        let threadId: string | null = p.threadId;
        let settled = 0;
        if (decision === 'REJECT') {
            await StoryThreadProposalRepository.decide(db, ctx.workspaceId, p.id, { status: 'REJECTED', decidedById: ctx.userId, at });
        } else if (p.op === 'NEW_THREAD') {
            if ((await StoryThreadRepository.count(db, ctx.workspaceId, bookId)) >= THREADS_PER_BOOK_MAX) throw new ConflictError('This book holds as many threads as it can.', { reason: 'THREADS_FULL', max: THREADS_PER_BOOK_MAX });
            const clean = sanitiseThreadForStorage({ title: p.title ?? '', note: null });
            const row = await StoryThreadRepository.create(db, ctx.workspaceId, { bookId, kind: p.kind, title: clean.title, note: null, state: 'OPEN', subjectElementId: p.subjectElementId, createdById: ctx.userId });
            threadId = row.id;
            await StoryThreadProposalRepository.decide(db, ctx.workspaceId, p.id, { status: 'ACCEPTED', decidedById: ctx.userId, at, threadId: row.id });
        } else {
            if (!p.threadId || !(await StoryThreadRepository.setState(db, ctx.workspaceId, p.threadId, { state: p.proposedState, updatedById: ctx.userId }))) {
                throw new ConflictError('That thread is no longer open.', { reason: 'THREAD_NOT_OPEN' });
            }
            await StoryThreadProposalRepository.decide(db, ctx.workspaceId, p.id, { status: 'ACCEPTED', decidedById: ctx.userId, at });
            settled = await StoryThreadProposalRepository.rejectOpenForThread(db, ctx.workspaceId, p.threadId, { decidedById: ctx.userId, at });
        }
        const status = decision === 'REJECT' ? 'REJECTED' : 'ACCEPTED';
        // AUDIT LAST (3.H).
        await logEvent(ctx, { action: 'STORY_THREAD_PROPOSAL_DECIDED', entityType: 'StoryThreadProposal', entityId: p.id, details: { bookId, decision, op: p.op, kind: p.kind, threadId, settled } }, { db });
        return { id: p.id, status, threadId };
    });
}

/** The author says a stale entry still holds: the flag is dismissed (a later change raises it again). */
export async function dismissStaleFlag(ctx: WorkspaceRequestContext, bookId: string, flagId: string): Promise<{ id: string }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const flag = await StaleFlagRepository.find(db, ctx.workspaceId, bookId, flagId);
        if (!flag) throw new NotFoundError('Flag not found.');
        if (!(await StaleFlagRepository.dismiss(db, ctx.workspaceId, flagId, { dismissedById: ctx.userId, at: new Date() }))) {
            throw new ConflictError('This flag is no longer open.', { reason: 'FLAG_NOT_OPEN' });
        }
        await logEvent(ctx, { action: 'STALE_FLAG_DISMISSED', entityType: 'StaleFlag', entityId: flagId, details: { bookId, elementId: flag.elementId, upstreamElementId: flag.upstreamElementId } }, { db });
        return { id: flagId };
    });
}

/** D35 addendum A: the book's continuity settings (`bible.view`); the defaults when the author has saved none. */
export async function getContinuitySettings(ctx: WorkspaceRequestContext, bookId: string): Promise<ContinuitySettingsView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const row = await ContinuitySettingsRepository.find(db, ctx.workspaceId, bookId);
        return { deepReadsDraft: row?.deepReadsDraft ?? false };
    });
}

/**
 * D35 addendum A: replace the book's continuity settings (`bible.edit`). Turning `deepReadsDraft` on makes the next
 * nightly deep check read the book's draft facts beside its bible facts (and spend from the same nightly share); off,
 * it reads the bible alone, as before. Audited with ids and the setting's value only. Audit last.
 */
export async function saveContinuitySettings(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<ContinuitySettingsView> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        // The book first: a deleted book answers 404 whatever the body says.
        await requireBook(db, ctx, bookId);
        const parsed = ContinuitySettingsInput.safeParse(input);
        if (!parsed.success) throw new ValidationError('Those settings are not valid.', { reason: 'SETTINGS_INVALID' });
        const before = await ContinuitySettingsRepository.find(db, ctx.workspaceId, bookId);
        // Turned on: from now the draft facts already read are new to the deep check (its next pass reads them); kept on,
        // the moment stays; off, none.
        const on = parsed.data.deepReadsDraft;
        const since = on ? (before?.deepReadsDraft && before.deepReadsDraftSince ? before.deepReadsDraftSince : new Date()) : null;
        const row = await ContinuitySettingsRepository.save(db, ctx.workspaceId, bookId, { deepReadsDraft: on, since });
        // A save that changes nothing is not an event; a change is audited with ids and the value only. Audit last.
        if ((before?.deepReadsDraft ?? false) !== row.deepReadsDraft) {
            await logEvent(ctx, { action: 'CONTINUITY_SETTINGS_SAVED', entityType: 'Book', entityId: bookId, details: { bookId, deepReadsDraft: row.deepReadsDraft } }, { db });
        }
        return { deepReadsDraft: row.deepReadsDraft };
    });
}
