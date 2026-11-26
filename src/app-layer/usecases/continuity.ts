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
    decideLaterAnswersOf,
    StaleFlagRepository,
    StoryThreadProposalRepository,
    StoryThreadRepository,
    type StoryThreadRow,
} from '@/app-layer/repositories/continuity.repository';
import { BibleVersionReadRepository, FactProposalRepository } from '@/app-layer/repositories/fact-layer.repository';
import { ContinuityThreadInput, ContinuityThreadUpdateInput, ThreadProposalDecisionInput } from '@/app-layer/schemas/continuity';
import { VersionNumberParam } from '@/app-layer/schemas/bible';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { sanitiseThreadForStorage } from '@/lib/continuity/storage';
import { CONTINUITY_LIST_MAX, threadStateAllowed, THREADS_PER_BOOK_MAX, type ContinuityOutcome, type ThreadKind } from '@/lib/continuity/vocabulary';
import { requireBook } from './bible-common';
import { storedTextOf } from './interview-state';
import { views, type FactProposalView } from './fact-proposals';
import { standingStaleFlags } from './stale-flags';

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
        /** 4.H-a (#62 item 3): subjects of the pass (or the last complete one) passed over after failing night after night. */
        parkedSubjects: number;
        /** Every live fact checked: a complete pass, nothing cut, nothing passed over (rule 6: never claimed otherwise). */
        complete: boolean;
    };
}

function threadView(t: StoryThreadRow, names: Map<string, string>): ThreadView {
    return {
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

        const check = await ContinuityCheckRepository.find(db, ctx.workspaceId, bookId);
        const last = await ContinuityRunRepository.lastFinished(db, ctx.workspaceId, bookId);
        // 4.H-a (#62 item 1): a run that read a cut set of facts says so (its metrics), and so does the page.
        const factsCut = !!last && typeof last.metrics === 'object' && last.metrics !== null && (last.metrics as { factsCut?: unknown }).factsCut === true;
        return {
            assessed: liveFacts > 0,
            liveFacts,
            contradictions: { items: await views(db, ctx, bookId, contradicted.slice(0, CONTINUITY_LIST_MAX)), pending: counts.contradicted, truncated: contradicted.length > CONTINUITY_LIST_MAX },
            noLongerStated: { items: await views(db, ctx, bookId, gone.slice(0, CONTINUITY_LIST_MAX)), pending: counts.noLongerStated, truncated: gone.length > CONTINUITY_LIST_MAX },
            threads: { items: threadsShown.map((t) => threadView(t, names)), truncated: threadRows.length > CONTINUITY_LIST_MAX },
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
                    toVersion: versionNumbers.get(f.upstreamVersionId) ?? null,
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
                complete: !!check?.coveredThrough && !check.passTarget && !factsCut && (check.parkedSubjects ?? 0) === 0 && liveFacts > 0,
            },
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
