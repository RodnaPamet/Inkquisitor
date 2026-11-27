/**
 * Continuity's rows (Phase 4.2, D28): the nightly check's state and runs, the
 * registries (threads and their proposals), propagation debt (stale flags),
 * and the fact reads the checks make. Every method takes the caller's
 * transaction and filters by workspace, except DISCOVERY, which the nightly
 * dispatcher makes through `runWithoutRls` (reason `continuity-discovery`) and
 * which returns ids only.
 *
 * A thread's and a proposal's text are encrypted (the manifest); their writers
 * here are called only with text the continuity sanitisers returned
 * (`encrypted-field-sanitiser-coverage`). Facts are written in
 * `source.repository.ts`; proposals to invalidate one in `fact-layer.repository.ts`.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import type { ContinuityOutcome, ContinuityRunStatus } from '@/lib/continuity/vocabulary';

type Db = PrismaTx;

// ─── The nightly check ─────────────────────────────────────────────

const CHECK_SELECT = { id: true, bookId: true, coveredThrough: true, passTarget: true, passCursor: true, lastRunAt: true, lastOutcome: true, pageFailures: true, parkedSubjects: true, passedOver: true, passedOverCut: true } as const satisfies Prisma.ContinuityCheckSelect;
export type ContinuityCheckRow = Prisma.ContinuityCheckGetPayload<{ select: typeof CHECK_SELECT }>;

export const ContinuityCheckRepository = {
    async find(db: Db, workspaceId: string, bookId: string): Promise<ContinuityCheckRow | null> {
        return db.continuityCheck.findFirst({ where: { workspaceId, bookId }, select: CHECK_SELECT });
    },
    async ensure(db: Db, workspaceId: string, bookId: string): Promise<ContinuityCheckRow> {
        return db.continuityCheck.upsert({ where: { workspaceId_bookId: { workspaceId, bookId } }, create: { workspaceId, bookId }, update: {}, select: CHECK_SELECT });
    },
    async save(
        db: Db,
        workspaceId: string,
        bookId: string,
        data: {
            coveredThrough?: Date | null;
            passTarget: Date | null;
            passCursor: string | null;
            lastRunAt: Date;
            lastOutcome: ContinuityOutcome;
            pageFailures?: number;
            parkedSubjects?: number;
            /** 4.H-b (D32): the subjects passed over and outstanding, and whether more were than the list holds. */
            passedOver?: string[];
            passedOverCut?: boolean;
        },
    ): Promise<void> {
        await db.continuityCheck.updateMany({ where: { workspaceId, bookId }, data });
    },
};

const RUN_SELECT = {
    id: true,
    bookId: true,
    status: true,
    outcome: true,
    passTarget: true,
    factsRead: true,
    ruleProposals: true,
    deepProposals: true,
    subjectsCovered: true,
    subjectsRemaining: true,
    callsMade: true,
    costMicroUsd: true,
    metrics: true,
    nightKey: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
} as const satisfies Prisma.ContinuityRunSelect;
export type ContinuityRunRow = Prisma.ContinuityRunGetPayload<{ select: typeof RUN_SELECT }>;

export const ContinuityRunRepository = {
    /**
     * D35 addendum B: does the deep check still have work in this workspace THIS night — a run of the night queued or
     * running? Read under the ledger's spend lock (the night's halves). A run that has ended (DONE, STOPPED, SKIPPED,
     * FAILED) does nothing more tonight, and a book not queued by the night's dispatch waits for the next night, so
     * neither holds the draft reading to its half. Bounded: one row.
     */
    async liveTonight(db: Db, workspaceId: string, nightKey: string): Promise<boolean> {
        const row = await db.continuityRun.findFirst({ where: { workspaceId, nightKey, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
        return row !== null;
    },
    /** A QUEUED run for the night `nightKey` names (4.H-a: one a book a night, the partial unique index answering P2002). */
    async create(db: Db, workspaceId: string, bookId: string, nightKey: string | null = null): Promise<{ id: string }> {
        return db.continuityRun.create({ data: { workspaceId, bookId, status: 'QUEUED', nightKey }, select: { id: true } });
    },
    async find(db: Db, workspaceId: string, id: string): Promise<ContinuityRunRow | null> {
        return db.continuityRun.findFirst({ where: { workspaceId, id }, select: RUN_SELECT });
    },
    /** A book's newest runs (the Continuity page's "last checked"; tests). */
    async listForBook(db: Db, workspaceId: string, bookId: string, take: number): Promise<ContinuityRunRow[]> {
        return db.continuityRun.findMany({ where: { workspaceId, bookId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: RUN_SELECT });
    },
    /** The book's newest run that has finished (DONE, STOPPED, SKIPPED or FAILED). */
    async lastFinished(db: Db, workspaceId: string, bookId: string): Promise<ContinuityRunRow | null> {
        return db.continuityRun.findFirst({ where: { workspaceId, bookId, finishedAt: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: RUN_SELECT });
    },
    /** QUEUED → RUNNING, conditionally; the claim's identity is `startedAt`. */
    async claim(db: Db, workspaceId: string, id: string, at: Date): Promise<boolean> {
        const r = await db.continuityRun.updateMany({ where: { workspaceId, id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: at } });
        return r.count === 1;
    },
    async finish(
        db: Db,
        workspaceId: string,
        id: string,
        data: {
            status: ContinuityRunStatus;
            outcome: ContinuityOutcome;
            from: ContinuityRunStatus[];
            claim?: Date;
            passTarget?: Date | null;
            counts: { factsRead: number; ruleProposals: number; deepProposals: number; subjectsCovered: number; subjectsRemaining: number; callsMade: number };
            promptVersion?: string | null;
            metrics: Prisma.InputJsonValue;
            at: Date;
        },
    ): Promise<boolean> {
        const r = await db.continuityRun.updateMany({
            where: { workspaceId, id, status: { in: data.from }, ...(data.claim ? { startedAt: data.claim } : {}) },
            data: {
                status: data.status,
                outcome: data.outcome,
                ...(data.passTarget !== undefined ? { passTarget: data.passTarget } : {}),
                ...data.counts,
                ...(data.promptVersion !== undefined ? { promptVersion: data.promptVersion } : {}),
                metrics: data.metrics,
                finishedAt: data.at,
            },
        });
        return r.count === 1;
    },
    /** A book's live runs with no sign of life since `staleBefore` (a lost job or a dead worker): ended STOPPED CLAIM_EXPIRED, resumable. */
    async expireStale(db: Db, workspaceId: string, bookId: string, staleBefore: Date, at: Date): Promise<number> {
        const r = await db.continuityRun.updateMany({
            where: { workspaceId, bookId, status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lte: staleBefore } },
            data: { status: 'STOPPED', outcome: 'CLAIM_EXPIRED', finishedAt: at },
        });
        return r.count;
    },
    /** What a call cost, counted in its own transaction whatever becomes of the run. */
    async addCost(db: Db, workspaceId: string, id: string, costMicroUsd: number): Promise<void> {
        if (costMicroUsd <= 0) return;
        await db.continuityRun.updateMany({ where: { workspaceId, id }, data: { costMicroUsd: { increment: BigInt(Math.round(costMicroUsd)) } } });
    },
};

/** What discovery hands the dispatcher: ids only. */
export interface DueBook {
    workspaceId: string;
    bookId: string;
}

export const ContinuityDiscovery = {
    /**
     * DISCOVERY (outside RLS, ids only): the live books CHANGED since their last complete deep check — a live fact
     * created (or a book-library source fact confirmed) after the check's `coveredThrough`, or a pass under way —
     * with no live run (one QUEUED or RUNNING since `staleBefore`), SHARED FAIRLY between workspaces: each
     * workspace's books are numbered, and the list is taken in that number's order, so one workspace's hundred books
     * never hold back another's one. Within a workspace (and among workspaces in one round) the book checked least
     * recently comes first: a book stays due while its pass is under way (and, without an evaluation record, for as
     * long as that lasts), so an order fixed by id would hand the same books every night's places and never reach
     * the rest. A book with a run already dispatched for THIS night (`nightKey`, 4.H-a) is never due a second time.
     */
    async listDueBooks(db: PrismaClient, data: { take: number; staleBefore: Date; nightKey: string; workspaceIds?: readonly string[]; retryBefore?: Date }): Promise<DueBook[]> {
        // 4.H-b (D32): a book with subjects passed over and outstanding is due again once its last run is older than
        // `CONTINUITY_PASSED_OVER_RETRY_MS` (the caller's `retryBefore`), changed or not: its next pass retries them.
        const retryBefore = data.retryBefore ?? new Date(0);
        const scope = data.workspaceIds ? Prisma.sql`AND b."workspaceId" = ANY(${[...data.workspaceIds]}::text[])` : Prisma.empty;
        return db.$queryRaw<DueBook[]>(Prisma.sql`
            SELECT "workspaceId", "bookId" FROM (
                SELECT b."workspaceId", b."id" AS "bookId", c."lastRunAt",
                       row_number() OVER (PARTITION BY b."workspaceId" ORDER BY c."lastRunAt" ASC NULLS FIRST, b."id") AS rn
                FROM "Book" b
                LEFT JOIN "ContinuityCheck" c ON c."workspaceId" = b."workspaceId" AND c."bookId" = b."id"
                WHERE b."deletedAt" IS NULL ${scope}
                  AND (c."passTarget" IS NOT NULL
                       OR ((cardinality(c."passedOver") > 0 OR c."passedOverCut") AND c."lastRunAt" < ${retryBefore})
                       OR EXISTS (SELECT 1 FROM "StoryFact" f
                                  WHERE f."workspaceId" = b."workspaceId" AND f."bookId" = b."id" AND f."supersededAt" IS NULL
                                    -- 5.3: a draft fact (SCENE_TEXT) is never canon: the nightly draft reading compares it, and this check
                                    -- reads it only for a book whose author turned that on (D35 addendum A)
                                    AND (f."sourceKind"::text <> 'SCENE_TEXT'
                                         OR EXISTS (SELECT 1 FROM "ContinuitySettings" cs
                                                    WHERE cs."workspaceId" = b."workspaceId" AND cs."bookId" = b."id" AND cs."deepReadsDraft"))
                                    AND f."createdAt" > COALESCE(c."coveredThrough", '-infinity'::timestamp))
                       -- D35 addendum A: the draft reading turned on since the last complete pass, with a draft fact to read
                       OR EXISTS (SELECT 1 FROM "ContinuitySettings" cs
                                  JOIN "StoryFact" f ON f."workspaceId" = cs."workspaceId" AND f."bookId" = cs."bookId"
                                                    AND f."sourceKind"::text = 'SCENE_TEXT' AND f."supersededAt" IS NULL
                                  WHERE cs."workspaceId" = b."workspaceId" AND cs."bookId" = b."id" AND cs."deepReadsDraft"
                                    AND cs."deepReadsDraftSince" > COALESCE(c."coveredThrough", '-infinity'::timestamp))
                       OR EXISTS (SELECT 1 FROM "StoryFact" f
                                  JOIN "Source" s ON s."workspaceId" = f."workspaceId" AND s."id" = f."sourceId"
                                  JOIN "SourceLibrary" l ON l."workspaceId" = s."workspaceId" AND l."id" = s."libraryId"
                                  WHERE f."workspaceId" = b."workspaceId" AND l."bookId" = b."id" AND f."status" = 'CONFIRMED'
                                    AND f."supersededAt" IS NULL AND f."decidedAt" > COALESCE(c."coveredThrough", '-infinity'::timestamp)))
                  AND NOT EXISTS (SELECT 1 FROM "ContinuityRun" r
                                  WHERE r."workspaceId" = b."workspaceId" AND r."bookId" = b."id"
                                    AND r."status" IN ('QUEUED', 'RUNNING') AND r."createdAt" > ${data.staleBefore})
                  -- 4.H-a (#62 item 4): a book that already had a run dispatched for this night is not queued again.
                  AND NOT EXISTS (SELECT 1 FROM "ContinuityRun" r
                                  WHERE r."workspaceId" = b."workspaceId" AND r."bookId" = b."id" AND r."nightKey" = ${data.nightKey})
            ) due
            ORDER BY rn, "lastRunAt" ASC NULLS FIRST, "workspaceId", "bookId"
            LIMIT ${data.take}`);
    },
};

// ─── The book's continuity settings (D35 addendum A) ───────────────

const SETTINGS_SELECT = { deepReadsDraft: true, deepReadsDraftSince: true, updatedAt: true } as const satisfies Prisma.ContinuitySettingsSelect;
export type ContinuitySettingsRow = Prisma.ContinuitySettingsGetPayload<{ select: typeof SETTINGS_SELECT }>;

export const ContinuitySettingsRepository = {
    /** The book's settings, or null (the defaults: the deep check reads the bible only). */
    async find(db: Db, workspaceId: string, bookId: string): Promise<ContinuitySettingsRow | null> {
        return db.continuitySettings.findFirst({ where: { workspaceId, bookId }, select: SETTINGS_SELECT });
    },
    /** Write the book's settings (created on the first save); `since` is when the draft reading was turned on (null: off). */
    async save(db: Db, workspaceId: string, bookId: string, data: { deepReadsDraft: boolean; since: Date | null }): Promise<ContinuitySettingsRow> {
        return db.continuitySettings.upsert({
            where: { workspaceId_bookId: { workspaceId, bookId } },
            create: { workspaceId, bookId, deepReadsDraft: data.deepReadsDraft, deepReadsDraftSince: data.since },
            update: { deepReadsDraft: data.deepReadsDraft, deepReadsDraftSince: data.since },
            select: SETTINGS_SELECT,
        });
    },
};

// ─── Facts as the checks read them ────────────────────────────────

const CHECK_FACT_SELECT = {
    id: true,
    sourceKind: true,
    elementId: true,
    subjectName: true,
    subjectElementId: true,
    predicate: true,
    objectLiteral: true,
    statement: true,
    storyTimeFrom: true,
    storyTimeTo: true,
    statedAt: true,
    createdAt: true,
    decidedAt: true,
} as const satisfies Prisma.StoryFactSelect;
export type CheckFactRow = Prisma.StoryFactGetPayload<{ select: typeof CHECK_FACT_SELECT }>;

const CHECK_DRAFT_FACT_SELECT = { ...CHECK_FACT_SELECT, sceneId: true, dedupeKey: true } as const satisfies Prisma.StoryFactSelect;
/** D35 addendum A: a live DRAFT fact as the deep check reads it — its scene and its claim key beside the fact. */
export type CheckDraftFactRow = Prisma.StoryFactGetPayload<{ select: typeof CHECK_DRAFT_FACT_SELECT }>;

export const ContinuityFactRepository = {
    /**
     * A book's LIVE facts the continuity checks read: its bible facts, the author's explanations, and the confirmed
     * facts of its OWN library's sources (never a series source's: shared with other books, it is never proposed for
     * invalidation by one of them, 4.1's rule). Linked subjects only (a rule never crosses subjects, and a page is a
     * subject's facts). Bounded; one more is asked so a cut is known.
     */
    async listLiveForBook(db: Db, workspaceId: string, bookId: string, bookSourceIds: readonly string[], take: number): Promise<CheckFactRow[]> {
        return db.storyFact.findMany({
            where: {
                workspaceId,
                supersededAt: null,
                subjectElementId: { not: null },
                OR: [
                    { bookId, sourceKind: { in: ['BIBLE_VERSION', 'RELATION_VERSION', 'AUTHOR_RESOLUTION'] } },
                    ...(bookSourceIds.length > 0 ? [{ sourceId: { in: [...bookSourceIds] }, sourceKind: 'SOURCE_CHUNK' as const, status: 'CONFIRMED' as const }] : []),
                ],
            },
            orderBy: [{ subjectElementId: 'asc' }, { statedAt: 'asc' }, { id: 'asc' }],
            take,
            select: CHECK_FACT_SELECT,
        });
    },
    /**
     * D35 addendum A: a book's live DRAFT facts (SCENE_TEXT) the deep check reads beside its bible facts when the author
     * turned that on — linked subjects only, keyed claims only, a subject's newest first. Bounded; one more is asked so a
     * cut is known.
     */
    async listLiveDraftForBook(db: Db, workspaceId: string, bookId: string, take: number): Promise<CheckDraftFactRow[]> {
        return db.storyFact.findMany({
            // 5.H-a: a deleted scene's draft facts are kept for its restore, and read by nothing meanwhile.
            where: { workspaceId, bookId, sourceKind: 'SCENE_TEXT', supersededAt: null, subjectElementId: { not: null }, sceneId: { not: null }, dedupeKey: { not: null }, scene: { is: { deletedAt: null } } },
            orderBy: [{ subjectElementId: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
            take,
            select: CHECK_DRAFT_FACT_SELECT,
        });
    },
    /** How many live bible facts a book holds (the Continuity page: zero is "not assessed", rule 6). */
    async countLiveBibleFacts(db: Db, workspaceId: string, bookId: string): Promise<number> {
        return db.storyFact.count({ where: { workspaceId, bookId, supersededAt: null, sourceKind: { in: ['BIBLE_VERSION', 'RELATION_VERSION', 'AUTHOR_RESOLUTION'] } } });
    },
    /** Which of these facts are still live (a pair is proposed only between two). */
    async liveIds(db: Db, workspaceId: string, ids: readonly string[]): Promise<Set<string>> {
        if (ids.length === 0) return new Set();
        const rows = await db.storyFact.findMany({ where: { workspaceId, id: { in: [...ids] }, supersededAt: null }, take: ids.length, select: { id: true } });
        return new Set(rows.map((r) => r.id));
    },
    /** A proposal's explanation (the fact the author wrote resolving it). */
    async explanationsFor(db: Db, workspaceId: string, proposalIds: readonly string[]): Promise<Map<string, { id: string; statement: string }>> {
        if (proposalIds.length === 0) return new Map();
        const rows = await db.storyFact.findMany({ where: { workspaceId, resolvesProposalId: { in: [...proposalIds] } }, take: proposalIds.length, select: { id: true, statement: true, resolvesProposalId: true } });
        return new Map(rows.map((r) => [r.resolvesProposalId!, { id: r.id, statement: r.statement }] as const));
    },
};

/** The book's placed elements of the ordered kinds (D25), for the story clock. Bounded; one more is asked. */
export async function placedElementsOf(db: Db, workspaceId: string, bookId: string, take: number) {
    return db.bibleElement.findMany({
        where: { workspaceId, bookId, orderRank: { not: null } },
        orderBy: [{ kind: 'asc' }, { orderRank: 'asc' }, { id: 'asc' }],
        take,
        select: { id: true, kind: true, name: true, orderRank: true },
    });
}

// ─── The registries ────────────────────────────────────────────────

const THREAD_SELECT = {
    id: true,
    bookId: true,
    kind: true,
    title: true,
    note: true,
    state: true,
    subjectElementId: true,
    version: true,
    createdAt: true,
    updatedAt: true,
} as const satisfies Prisma.StoryThreadSelect;
export type StoryThreadRow = Prisma.StoryThreadGetPayload<{ select: typeof THREAD_SELECT }>;

export const StoryThreadRepository = {
    async list(db: Db, workspaceId: string, bookId: string, take: number): Promise<StoryThreadRow[]> {
        return db.storyThread.findMany({ where: { workspaceId, bookId }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take, select: THREAD_SELECT });
    },
    /** A book's OPEN threads, oldest first (what an extraction is shown, to suggest one paid off). Ids, kinds and titles only. */
    async listOpen(db: Db, workspaceId: string, bookId: string, take: number): Promise<Array<{ id: string; kind: string; title: string }>> {
        return db.storyThread.findMany({ where: { workspaceId, bookId, state: 'OPEN' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: { id: true, kind: true, title: true } });
    },
    async count(db: Db, workspaceId: string, bookId: string): Promise<number> {
        return db.storyThread.count({ where: { workspaceId, bookId } });
    },
    /** Phase 4.4: which of these threads are still OPEN (a continuity question's persist). */
    async openAmong(db: Db, workspaceId: string, bookId: string, ids: readonly string[]): Promise<string[]> {
        if (ids.length === 0) return [];
        const rows = await db.storyThread.findMany({ where: { workspaceId, bookId, id: { in: [...ids] }, state: 'OPEN' }, take: ids.length, select: { id: true } });
        return rows.map((r) => r.id);
    },
    /** Phase 4.4: a book's OPEN threads about these elements (the continuity generator's open threads), oldest first. */
    async listOpenAbout(db: Db, workspaceId: string, bookId: string, elementIds: readonly string[], take: number): Promise<Array<{ id: string; kind: string; title: string; subjectElementId: string | null }>> {
        if (elementIds.length === 0) return [];
        return db.storyThread.findMany({
            where: { workspaceId, bookId, state: 'OPEN', subjectElementId: { in: [...elementIds] } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take,
            select: { id: true, kind: true, title: true, subjectElementId: true },
        });
    },
    /** Phase 5.3: some of a book's threads by id (a list of thread links names them), in one read. */
    async byIds(db: Db, workspaceId: string, bookId: string, ids: readonly string[]): Promise<StoryThreadRow[]> {
        if (ids.length === 0) return [];
        return db.storyThread.findMany({ where: { workspaceId, bookId, id: { in: [...ids] } }, take: ids.length, select: THREAD_SELECT });
    },
    async find(db: Db, workspaceId: string, bookId: string, id: string): Promise<StoryThreadRow | null> {
        return db.storyThread.findFirst({ where: { workspaceId, bookId, id }, select: THREAD_SELECT });
    },
    /** A new thread. Its title and note are `sanitiseThreadForStorage`'s. */
    async create(db: Db, workspaceId: string, data: { bookId: string; kind: string; title: string; note: string | null; state: string; subjectElementId: string | null; createdById: string }): Promise<StoryThreadRow> {
        return db.storyThread.create({
            data: {
                workspaceId,
                bookId: data.bookId,
                kind: data.kind,
                title: data.title,
                note: data.note,
                state: data.state,
                subjectElementId: data.subjectElementId,
                createdById: data.createdById,
                updatedById: data.createdById,
            },
            select: THREAD_SELECT,
        });
    },
    /** Change a thread made against `baseVersion` (false when it moved meanwhile). Its title and note are `sanitiseThreadForStorage`'s. */
    async update(
        db: Db,
        workspaceId: string,
        id: string,
        baseVersion: number,
        data: { title: string; note: string | null; state: string; subjectElementId: string | null; updatedById: string },
    ): Promise<boolean> {
        const r = await db.storyThread.updateMany({
            where: { workspaceId, id, version: baseVersion },
            data: { title: data.title, note: data.note, state: data.state, subjectElementId: data.subjectElementId, updatedById: data.updatedById, version: { increment: 1 } },
        });
        return r.count === 1;
    },
    /** A thread's state moved by an accepted proposal (a promise paid off), whatever its version, writing no text. */
    async setState(db: Db, workspaceId: string, id: string, data: { state: string; updatedById: string }): Promise<boolean> {
        const r = await db.storyThread.updateMany({ where: { workspaceId, id, state: 'OPEN' }, data: { state: data.state, updatedById: data.updatedById, version: { increment: 1 } } });
        return r.count === 1;
    },
    async remove(db: Db, workspaceId: string, id: string, baseVersion: number): Promise<boolean> {
        const r = await db.storyThread.deleteMany({ where: { workspaceId, id, version: baseVersion } });
        return r.count === 1;
    },
};

const THREAD_PROPOSAL_SELECT = {
    id: true,
    bookId: true,
    op: true,
    kind: true,
    title: true,
    proposedState: true,
    threadId: true,
    bibleVersionId: true,
    relationVersionId: true,
    quote: true,
    subjectElementId: true,
    flags: true,
    status: true,
    createdAt: true,
} as const satisfies Prisma.StoryThreadProposalSelect;
export type StoryThreadProposalRow = Prisma.StoryThreadProposalGetPayload<{ select: typeof THREAD_PROPOSAL_SELECT }>;

export interface ThreadProposalInsert {
    bookId: string;
    op: 'NEW_THREAD' | 'SET_STATE';
    kind: string;
    title: string | null;
    proposedState: string;
    threadId: string | null;
    extractionId: string;
    bibleVersionId: string | null;
    relationVersionId: string | null;
    quote: string;
    quoteStart: number;
    quoteEnd: number;
    subjectElementId: string | null;
    dedupeKey: string;
    flags: string[];
}

export const StoryThreadProposalRepository = {
    /** Raise proposals, one per claim in a book, ever (a claim already proposed, decided or not, is skipped). Text is `sanitiseThreadProposalForStorage`'s. */
    async raise(db: Db, workspaceId: string, rows: readonly ThreadProposalInsert[]): Promise<number> {
        if (rows.length === 0) return 0;
        const r = await db.storyThreadProposal.createMany({
            data: rows.map((x) => ({
                workspaceId,
                bookId: x.bookId,
                op: x.op,
                kind: x.kind,
                title: x.title,
                proposedState: x.proposedState,
                threadId: x.threadId,
                extractionId: x.extractionId,
                bibleVersionId: x.bibleVersionId,
                relationVersionId: x.relationVersionId,
                quote: x.quote,
                quoteStart: x.quoteStart,
                quoteEnd: x.quoteEnd,
                subjectElementId: x.subjectElementId,
                dedupeKey: x.dedupeKey,
                flags: x.flags,
            })),
            skipDuplicates: true,
        });
        return r.count;
    },
    async listPending(db: Db, workspaceId: string, bookId: string, take: number): Promise<StoryThreadProposalRow[]> {
        return db.storyThreadProposal.findMany({ where: { workspaceId, bookId, status: 'PENDING' }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: THREAD_PROPOSAL_SELECT });
    },
    async countPending(db: Db, workspaceId: string, bookId: string): Promise<number> {
        return db.storyThreadProposal.count({ where: { workspaceId, bookId, status: 'PENDING' } });
    },
    async find(db: Db, workspaceId: string, bookId: string, id: string): Promise<StoryThreadProposalRow | null> {
        return db.storyThreadProposal.findFirst({ where: { workspaceId, bookId, id }, select: THREAD_PROPOSAL_SELECT });
    },
    /** Decide a PENDING proposal, once; an accepted new thread names the thread it created. */
    async decide(db: Db, workspaceId: string, id: string, data: { status: 'ACCEPTED' | 'REJECTED'; decidedById: string; at: Date; threadId?: string }): Promise<boolean> {
        const r = await db.storyThreadProposal.updateMany({
            where: { workspaceId, id, status: 'PENDING' },
            data: { status: data.status, decidedById: data.decidedById, decidedAt: data.at, threadId: data.threadId ?? undefined },
        });
        return r.count === 1;
    },
    /** Settle the other pending pay-offs of a thread just closed: there is nothing left for them to change. */
    async rejectOpenForThread(db: Db, workspaceId: string, threadId: string, data: { decidedById: string; at: Date }): Promise<number> {
        const r = await db.storyThreadProposal.updateMany({ where: { workspaceId, threadId, op: 'SET_STATE', status: 'PENDING' }, data: { status: 'REJECTED', decidedById: data.decidedById, decidedAt: data.at } });
        return r.count;
    },
};

// ─── Propagation debt ──────────────────────────────────────────────

const STALE_SELECT = {
    id: true,
    bookId: true,
    elementId: true,
    upstreamElementId: true,
    basis: true,
    citedVersionId: true,
    baseVersionId: true,
    upstreamVersionId: true,
    downstreamVersionNumber: true,
    status: true,
    raisedAt: true,
} as const satisfies Prisma.StaleFlagSelect;
export type StaleFlagRow = Prisma.StaleFlagGetPayload<{ select: typeof STALE_SELECT }>;

export const StaleFlagRepository = {
    /** A book's flags still OPEN, newest first (the caller drops those their entry's save has cleared). One more is asked. */
    async listOpen(db: Db, workspaceId: string, bookId: string, take: number): Promise<StaleFlagRow[]> {
        return db.staleFlag.findMany({ where: { workspaceId, bookId, status: 'OPEN' }, orderBy: [{ raisedAt: 'desc' }, { id: 'asc' }], take, select: STALE_SELECT });
    },
    async find(db: Db, workspaceId: string, bookId: string, id: string): Promise<StaleFlagRow | null> {
        return db.staleFlag.findFirst({ where: { workspaceId, bookId, id }, select: STALE_SELECT });
    },
    /** The newest version number of each of these elements that is not a reorder (a save of it clears its flags). */
    async newestContentVersions(db: Db, workspaceId: string, elementIds: readonly string[]): Promise<Map<string, number>> {
        if (elementIds.length === 0) return new Map();
        const rows = await db.bibleEntryVersion.groupBy({
            by: ['elementId'],
            where: { workspaceId, elementId: { in: [...elementIds] }, movedInOrder: false },
            _max: { versionNumber: true },
            orderBy: { elementId: 'asc' },
            take: elementIds.length,
        });
        return new Map(rows.map((r) => [r.elementId, r._max.versionNumber ?? 0] as const));
    },
    async dismiss(db: Db, workspaceId: string, id: string, data: { dismissedById: string; at: Date }): Promise<boolean> {
        const r = await db.staleFlag.updateMany({ where: { workspaceId, id, status: 'OPEN' }, data: { status: 'DISMISSED', dismissedAt: data.at, dismissedById: data.dismissedById } });
        return r.count === 1;
    },
    /** The nightly sweep: flags a save of their entry has already cleared (read) are written CLEARED, so lists stay short. */
    async markCleared(db: Db, workspaceId: string, ids: readonly string[]): Promise<number> {
        if (ids.length === 0) return 0;
        const r = await db.staleFlag.updateMany({ where: { workspaceId, id: { in: [...ids] }, status: 'OPEN' }, data: { status: 'CLEARED' } });
        return r.count;
    },
};

/** The answers a stale entry's versions cite (`sourceAnswerIds`), with what each answered question was about. Bounded. */
export async function citedAnswersOf(db: Db, workspaceId: string, bookId: string, elementId: string, take: number): Promise<Array<{ answerId: string; questionElementId: string; questionRelationId: string | null; aboutPending: boolean }>> {
    const versions = await db.bibleEntryVersion.findMany({ where: { workspaceId, bookId, elementId, NOT: { sourceAnswerIds: { isEmpty: true } } }, orderBy: { versionNumber: 'desc' }, take, select: { sourceAnswerIds: true } });
    const ids = [...new Set(versions.flatMap((v) => v.sourceAnswerIds))].slice(0, take * 4);
    if (ids.length === 0) return [];
    const answers = await db.answer.findMany({ where: { workspaceId, id: { in: ids } }, take: ids.length, select: { id: true, question: { select: { elementId: true, relationId: true, aboutPending: true } } } });
    return answers.map((a) => ({ answerId: a.id, questionElementId: a.question.elementId, questionRelationId: a.question.relationId, aboutPending: a.question.aboutPending }));
}

/** The fields of an element set by accepted proposals that cite these answers (a stale entry's fields a change may touch). */
export async function acceptedFieldsCiting(db: Db, workspaceId: string, elementId: string, answerIds: readonly string[], take: number): Promise<string[]> {
    if (answerIds.length === 0) return [];
    const rows = await db.enrichmentProposal.findMany({
        where: { workspaceId, elementId, status: { in: ['ACCEPTED', 'EDITED_ACCEPTED'] }, citations: { some: { answerId: { in: [...answerIds] } } } },
        take,
        select: { fieldKey: true },
    });
    return [...new Set(rows.map((r) => r.fieldKey).filter((k): k is string => !!k))];
}

/**
 * A book's "decide later" answers (Phase 4.2: they feed the open questions), newest first: each answer's question,
 * and every revision of those questions' answers (the caller keeps a question only while its LATEST answer is still
 * DECIDE_LATER). Bounded; one more is asked.
 */
export async function decideLaterAnswersOf(db: Db, workspaceId: string, bookId: string, take: number) {
    const rows = await db.answer.findMany({
        where: { workspaceId, status: 'DECIDE_LATER', question: { bookId, aboutPending: false } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        select: { id: true, questionId: true, revision: true, sessionId: true, createdAt: true, question: { select: { id: true, elementId: true, relationId: true, pairElementId: true, targetsFieldKeys: true, text: true } } },
    });
    const questionIds = [...new Set(rows.map((r) => r.questionId))];
    const revisions = questionIds.length === 0 ? [] : await db.answer.findMany({ where: { workspaceId, questionId: { in: questionIds } }, orderBy: { revision: 'desc' }, take: questionIds.length * 21, select: { questionId: true, revision: true, status: true } });
    return { rows, revisions };
}
