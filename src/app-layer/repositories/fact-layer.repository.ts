/**
 * The fact layer's rows that hold no text (Phase 4.1, D27): the extraction
 * outbox, provenance, invalidation proposals and embedding tasks, and the
 * version reads an extraction needs. Every method takes the caller's
 * transaction and filters by workspace, except the two DISCOVERY reads, which
 * the minutely dispatcher makes through `runWithoutRls` (reason
 * `fact-layer-discovery`) and which return ids only.
 *
 * Fact rows themselves (text, encrypted) are written in `source.repository.ts`
 * (`StoryFactRepository.createBibleFacts`, `BibleFactRepository.supersede`).
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import type { FactExtractionOrigin, FactExtractionOutcome, FactExtractionStatus, FactProposalStatus } from '@/lib/facts/vocabulary';
import { fromCursor, roundRobin } from './job-cursor.repository';

type Db = PrismaTx;

const EXTRACTION_SELECT = {
    id: true,
    workspaceId: true,
    bookId: true,
    kind: true,
    elementId: true,
    relationId: true,
    bibleVersionId: true,
    relationVersionId: true,
    status: true,
    outcome: true,
    attempts: true,
    nextAttemptAt: true,
    factsAdded: true,
    provenanceAdded: true,
    proposalsRaised: true,
    costMicroUsd: true,
    createdAt: true,
    queuedAt: true,
    startedAt: true,
    finishedAt: true,
    origin: true,
} as const satisfies Prisma.BibleFactExtractionSelect;
export type FactExtractionRow = Prisma.BibleFactExtractionGetPayload<{ select: typeof EXTRACTION_SELECT }>;

const PROPOSAL_SELECT = { id: true, bookId: true, factId: true, newerFactId: true, reason: true, basis: true, kind: true, status: true, decidedAt: true, createdAt: true } as const satisfies Prisma.StoryFactProposalSelect;
export type FactProposalRow = Prisma.StoryFactProposalGetPayload<{ select: typeof PROPOSAL_SELECT }>;

/**
 * Every proposal (decided or not) between two of these facts, as `older|newer` keys (Phase 4.2). The facts are named
 * as two id lists, never one OR branch per pair: a nightly rule sweep over a large subject names tens of thousands of
 * pairs, and as branches they ran past PostgreSQL's bind-parameter limit in one query (or, cut into slices, past the
 * transaction's timeout), failing the whole run every night. The ids are a bounded fact read's, so their pairs bound
 * the rows.
 */
async function proposedPairsAmong(db: Db, workspaceId: string, factIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(factIds)];
    if (ids.length < 2) return new Set();
    const rows = await db.storyFactProposal.findMany({
        where: { workspaceId, factId: { in: ids }, newerFactId: { in: ids } },
        take: ids.length * (ids.length - 1),
        select: { factId: true, newerFactId: true },
    });
    return new Set(rows.map((r) => `${r.factId}|${r.newerFactId}`));
}

/** When an extraction is due (the dispatcher's window): discovery and the mark ask the same predicate. */
export interface ExtractionDueWindow {
    now: Date;
    settledBefore: Date;
    staleBefore: Date;
}

/** What discovery hands the dispatcher: ids and codes only. */
const DUE_SELECT = { id: true, workspaceId: true, attempts: true, status: true, outcome: true } as const satisfies Prisma.BibleFactExtractionSelect;
export type DueExtraction = Prisma.BibleFactExtractionGetPayload<{ select: typeof DUE_SELECT }>;


/**
 * Due by the window, of one origin (4.H-b): a SAVE row once settled (a run of autosaves is read once), a BACKFILL row at
 * once (its version is old); STOPPED ones whose next attempt is due and stale claims either way.
 */
function dueWhere(data: ExtractionDueWindow, origin: FactExtractionOrigin = 'SAVE'): Prisma.BibleFactExtractionWhereInput {
    return {
        origin,
        OR: [
            origin === 'SAVE' ? { status: 'PENDING', createdAt: { lt: data.settledBefore } } : { status: 'PENDING' },
            { status: 'STOPPED', nextAttemptAt: { lte: data.now } },
            { status: 'QUEUED', queuedAt: { lt: data.staleBefore } },
            { status: 'RUNNING', startedAt: { lt: data.staleBefore } },
        ],
    };
}

export const FactExtractionRepository = {
    async find(db: Db, workspaceId: string, id: string): Promise<FactExtractionRow | null> {
        return db.bibleFactExtraction.findFirst({ where: { workspaceId, id }, select: EXTRACTION_SELECT });
    },
    async findForVersion(db: Db, workspaceId: string, version: { bibleVersionId: string } | { relationVersionId: string }): Promise<FactExtractionRow | null> {
        return db.bibleFactExtraction.findFirst({ where: { workspaceId, ...version }, select: EXTRACTION_SELECT });
    },
    /** A book's extractions, newest first (tests, the job's own checks). */
    async listForBook(db: Db, workspaceId: string, bookId: string, take: number): Promise<FactExtractionRow[]> {
        return db.bibleFactExtraction.findMany({ where: { workspaceId, bookId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: EXTRACTION_SELECT });
    },
    /**
     * DISCOVERY (outside RLS, ids only): due extractions across workspaces — PENDING ones settled for
     * `settledBefore`, STOPPED ones whose next attempt is due, and QUEUED or RUNNING ones with no sign of life since
     * `staleBefore` (a lost job or a dead worker) — SHARED FAIRLY (owner decision, 2026-11-21): the workspaces with
     * due rows (oldest due row first, at most `take` of them) each get up to an even share of `take`, oldest first
     * within the workspace, and the rows are interleaved round-robin before the cut. One workspace's backlog (a month
     * of ceiling stops coming due at once) never starves another's new extractions.
     */
    async listDue(
        db: PrismaClient,
        data: ExtractionDueWindow & { take: number; workspaceIds?: readonly string[]; cursor?: string; origin?: FactExtractionOrigin },
    ): Promise<{ rows: DueExtraction[]; next: string }> {
        const origin = data.origin ?? 'SAVE';
        // 4.H-b (#60.4): the workspaces with due rows are taken in WORKSPACE order from the cursor (the last one served),
        // wrapping round: with more busy workspaces than a tick serves, each is reached within ⌈busy ÷ take⌉ ticks. They
        // were taken oldest due row first, so a few hundred workspaces with old backlogs held every tick's places and a
        // workspace with one new save waited until they drained.
        const groups = (filter: Prisma.StringFilter, take: number) =>
            db.bibleFactExtraction.groupBy({
                by: ['workspaceId'],
                where: { ...dueWhere(data, origin), workspaceId: { ...filter, ...(data.workspaceIds ? { in: [...data.workspaceIds] } : {}) } },
                orderBy: { workspaceId: 'asc' },
                take,
            });
        const taken = await fromCursor(
            data.cursor ?? '',
            data.take,
            (cursor, take) => groups({ gt: cursor }, take),
            (cursor, take) => groups({ lte: cursor }, take),
        );
        if (taken.items.length === 0) return { rows: [], next: taken.next };
        const share = Math.max(1, Math.ceil(data.take / taken.items.length));
        const lists: DueExtraction[][] = [];
        for (const g of taken.items) {
            // One bounded read per workspace with due rows (at most `take` of them): the fair share's own shape.
            lists.push(
                await db.bibleFactExtraction.findMany({
                    where: { workspaceId: g.workspaceId, ...dueWhere(data, origin) },
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    take: share,
                    select: DUE_SELECT,
                }),
            );
        }
        return { rows: roundRobin(lists, data.take), next: taken.next };
    },
    /**
     * Mark a due row QUEUED, counting the attempt — only while it is STILL due by the same window discovery used,
     * asked in the same statement: a row another dispatcher tick queued meanwhile (and a worker may have claimed) is
     * fresh, not stale, and is left to its worker. Never steal a live claim: its call is already being paid for.
     */
    async markQueued(db: Db, workspaceId: string, id: string, at: Date, due: ExtractionDueWindow, origin: FactExtractionOrigin = 'SAVE'): Promise<boolean> {
        const r = await db.bibleFactExtraction.updateMany({
            where: { workspaceId, id, ...dueWhere(due, origin) },
            data: { status: 'QUEUED', queuedAt: at, startedAt: null, attempts: { increment: 1 } },
        });
        return r.count === 1;
    },
    /**
     * The workspace's month has no room (the ledger's own reading, asked by the dispatcher): its due rows WAIT,
     * STOPPED CEILING, looked at again at `until`, no attempt counted. A stale claim among them is ended with it.
     * Only while still due (the same window, the same statement).
     */
    async deferAtCeiling(db: Db, workspaceId: string, ids: readonly string[], due: ExtractionDueWindow, until: Date, origin: FactExtractionOrigin = 'SAVE'): Promise<number> {
        if (ids.length === 0) return 0;
        const r = await db.bibleFactExtraction.updateMany({
            where: { workspaceId, id: { in: [...ids] }, ...dueWhere(due, origin) },
            data: { status: 'STOPPED', outcome: 'CEILING', nextAttemptAt: until, queuedAt: null, startedAt: null },
        });
        return r.count;
    },
    /** QUEUED → RUNNING, conditionally; the claim's identity is `startedAt`. */
    async claim(db: Db, workspaceId: string, id: string, at: Date): Promise<boolean> {
        const r = await db.bibleFactExtraction.updateMany({ where: { workspaceId, id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: at } });
        return r.count === 1;
    },
    /** End or pause it; a claimed run names its claim (a re-dispatched row belongs to its new worker). */
    async finish(
        db: Db,
        workspaceId: string,
        id: string,
        data: {
            status: FactExtractionStatus;
            outcome: FactExtractionOutcome;
            from: FactExtractionStatus[];
            claim?: Date;
            nextAttemptAt?: Date | null;
            counts?: { factsAdded: number; provenanceAdded: number; proposalsRaised: number };
            costMicroUsd?: number;
            promptVersion?: string | null;
            metrics: Prisma.InputJsonValue;
            at: Date;
            /** Give back the attempt the dispatch counted (a stop at the ceiling or the kill switch spends none). */
            refundAttempt?: boolean;
            /** 4.H-b (D32): the sections the guard has refused so far and the rule version of each (a DONE row: the next baseline). */
            guardRefused?: Prisma.InputJsonValue | null;
        },
    ): Promise<boolean> {
        const r = await db.bibleFactExtraction.updateMany({
            where: { workspaceId, id, status: { in: data.from }, ...(data.claim ? { startedAt: data.claim } : {}), ...(data.refundAttempt ? { attempts: { gt: 0 } } : {}) },
            data: {
                ...(data.refundAttempt ? { attempts: { decrement: 1 } } : {}),
                status: data.status,
                outcome: data.outcome,
                nextAttemptAt: data.nextAttemptAt ?? null,
                ...(data.counts ? { factsAdded: { increment: data.counts.factsAdded }, provenanceAdded: { increment: data.counts.provenanceAdded }, proposalsRaised: { increment: data.counts.proposalsRaised } } : {}),
                ...(data.costMicroUsd ? { costMicroUsd: { increment: BigInt(Math.max(0, Math.round(data.costMicroUsd))) } } : {}),
                ...(data.promptVersion !== undefined ? { promptVersion: data.promptVersion } : {}),
                metrics: data.metrics,
                finishedAt: data.at,
                ...(data.guardRefused !== undefined ? { guardRefused: data.guardRefused === null ? Prisma.DbNull : data.guardRefused } : {}),
            },
        });
        return r.count === 1;
    },
    /** What a call cost, counted whatever became of the run (#57 item 5's lesson, applied here from the start). */
    async addCost(db: Db, workspaceId: string, id: string, costMicroUsd: number): Promise<void> {
        if (costMicroUsd <= 0) return;
        await db.bibleFactExtraction.updateMany({ where: { workspaceId, id }, data: { costMicroUsd: { increment: BigInt(Math.round(costMicroUsd)) } } });
    },
    /**
     * The element's newest extracted version (its BASELINE), other than `exceptVersionId`, and what its extraction
     * recorded the guard refused (4.H-b, D32: sent again once the guard's rules are newer).
     */
    async baselineForElement(db: Db, workspaceId: string, elementId: string, exceptVersionId: string): Promise<{ versionId: string; guardRefused: unknown } | null> {
        const row = await db.bibleFactExtraction.findFirst({
            where: { workspaceId, elementId, status: 'DONE', NOT: { bibleVersionId: exceptVersionId } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { bibleVersionId: true, guardRefused: true },
        });
        return row?.bibleVersionId ? { versionId: row.bibleVersionId, guardRefused: row.guardRefused } : null;
    },
    async baselineForRelation(db: Db, workspaceId: string, relationId: string, exceptVersionId: string): Promise<{ versionId: string; guardRefused: unknown } | null> {
        const row = await db.bibleFactExtraction.findFirst({
            where: { workspaceId, relationId, status: 'DONE', NOT: { relationVersionId: exceptVersionId } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { relationVersionId: true, guardRefused: true },
        });
        return row?.relationVersionId ? { versionId: row.relationVersionId, guardRefused: row.guardRefused } : null;
    },
};

export const BibleVersionReadRepository = {
    async elementVersion(db: Db, workspaceId: string, id: string) {
        return db.bibleEntryVersion.findFirst({ where: { workspaceId, id }, select: { id: true, bookId: true, elementId: true, versionNumber: true, snapshot: true, authorId: true } });
    },
    async relationVersion(db: Db, workspaceId: string, id: string) {
        return db.bibleRelationVersion.findFirst({ where: { workspaceId, id }, select: { id: true, bookId: true, relationId: true, versionNumber: true, snapshot: true, authorId: true } });
    },
    async newestElementVersionId(db: Db, workspaceId: string, elementId: string): Promise<string | null> {
        const row = await db.bibleEntryVersion.findFirst({ where: { workspaceId, elementId }, orderBy: { versionNumber: 'desc' }, select: { id: true } });
        return row?.id ?? null;
    },
    async newestRelationVersionId(db: Db, workspaceId: string, relationId: string): Promise<string | null> {
        const row = await db.bibleRelationVersion.findFirst({ where: { workspaceId, relationId }, orderBy: { versionNumber: 'desc' }, select: { id: true } });
        return row?.id ?? null;
    },
    /**
     * The NEWEST version of each of these elements, its snapshot decrypted (the entry as it stands: every save writes
     * one). The newest ids are found first with no text read, so exactly one snapshot per element is decrypted.
     */
    async newestElementSnapshots(db: Db, workspaceId: string, elementIds: readonly string[]): Promise<Map<string, string>> {
        if (elementIds.length === 0) return new Map();
        const newest = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT DISTINCT ON ("elementId") "id" FROM "BibleEntryVersion"
            WHERE "workspaceId" = ${workspaceId} AND "elementId" = ANY(${[...elementIds]}::text[])
            ORDER BY "elementId", "versionNumber" DESC`);
        if (newest.length === 0) return new Map();
        const rows = await db.bibleEntryVersion.findMany({ where: { workspaceId, id: { in: newest.map((r) => r.id) } }, take: newest.length, select: { elementId: true, snapshot: true } });
        return new Map(rows.map((r) => [r.elementId, r.snapshot] as const));
    },
    /** The newest version of each of these relations, its snapshot decrypted (as `newestElementSnapshots`). */
    async newestRelationSnapshots(db: Db, workspaceId: string, relationIds: readonly string[]): Promise<Map<string, string>> {
        if (relationIds.length === 0) return new Map();
        const newest = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT DISTINCT ON ("relationId") "id" FROM "BibleRelationVersion"
            WHERE "workspaceId" = ${workspaceId} AND "relationId" = ANY(${[...relationIds]}::text[])
            ORDER BY "relationId", "versionNumber" DESC`);
        if (newest.length === 0) return new Map();
        const rows = await db.bibleRelationVersion.findMany({ where: { workspaceId, id: { in: newest.map((r) => r.id) } }, take: newest.length, select: { relationId: true, snapshot: true } });
        return new Map(rows.map((r) => [r.relationId, r.snapshot] as const));
    },
    /** Version numbers by id (a proposal's provenance line). */
    async elementVersionNumbers(db: Db, workspaceId: string, ids: readonly string[]): Promise<Map<string, number>> {
        if (ids.length === 0) return new Map();
        const rows = await db.bibleEntryVersion.findMany({ where: { workspaceId, id: { in: [...ids] } }, take: ids.length, select: { id: true, versionNumber: true } });
        return new Map(rows.map((r) => [r.id, r.versionNumber] as const));
    },
};

export const FactProvenanceRepository = {
    /** Record that these facts were restated by a version (idempotent: one row per fact and version). Returns how many were new. */
    async add(db: Db, workspaceId: string, rows: ReadonlyArray<{ factId: string; sourceKind: 'BIBLE_VERSION' | 'RELATION_VERSION'; bibleVersionId: string | null; relationVersionId: string | null }>): Promise<number> {
        if (rows.length === 0) return 0;
        const r = await db.storyFactProvenance.createMany({ data: rows.map((x) => ({ workspaceId, ...x })), skipDuplicates: true });
        return r.count;
    },
    async countForFacts(db: Db, workspaceId: string, factIds: readonly string[]): Promise<Map<string, number>> {
        if (factIds.length === 0) return new Map();
        const rows = await db.storyFactProvenance.groupBy({ by: ['factId'], where: { workspaceId, factId: { in: [...factIds] } }, _count: { _all: true }, orderBy: { factId: 'asc' }, take: factIds.length });
        return new Map(rows.map((r) => [r.factId, r._count._all] as const));
    },
};

export const FactProposalRepository = {
    /** Raise proposals (one per pair, ever: a pair already proposed, decided or not, is skipped). Returns how many were new. */
    async raise(
        db: Db,
        workspaceId: string,
        rows: ReadonlyArray<{
            bookId: string;
            factId: string;
            newerFactId: string | null;
            reason: 'CONTRADICTED' | 'NO_LONGER_STATED';
            basis: 'RULE' | 'MODEL' | 'TEXT' | 'DEEP';
            /** Phase 4.2: a contradiction's kind (NULL for NO_LONGER_STATED). */
            kind: string | null;
            extractionId?: string | null;
            checkRunId?: string | null;
        }>,
    ): Promise<number> {
        if (rows.length === 0) return 0;
        // Phase 4.2: a pair already proposed in EITHER order (decided or not) is never proposed again; the unique
        // key is directional, so the reverse is asked here, under the caller's book fact lock.
        const pairs = rows.filter((r) => r.newerFactId !== null);
        const held = await proposedPairsAmong(db, workspaceId, pairs.flatMap((r) => [r.factId, r.newerFactId!]));
        const fresh = rows.filter((r) => r.newerFactId === null || !held.has(`${r.newerFactId}|${r.factId}`));
        if (fresh.length === 0) return 0;
        const r = await db.storyFactProposal.createMany({ data: fresh.map((x) => ({ workspaceId, ...x })), skipDuplicates: true });
        return r.count;
    },
    /** Phase 4.2: the unordered pairs among these that the book already holds a proposal for (decided or not). */
    async heldPairs(db: Db, workspaceId: string, pairs: ReadonlyArray<{ a: string; b: string }>): Promise<Set<string>> {
        const out = new Set<string>();
        for (const key of await proposedPairsAmong(db, workspaceId, pairs.flatMap((p) => [p.a, p.b]))) {
            const [a, b] = key.split('|');
            out.add(`${a}|${b}`).add(`${b}|${a}`);
        }
        return out;
    },
    /** Phase 4.2: a book's pending proposals of one reason (the Continuity page's contradictions, its no-longer-stated facts). */
    async listPendingByReason(db: Db, workspaceId: string, bookId: string, reason: 'CONTRADICTED' | 'NO_LONGER_STATED', take: number): Promise<FactProposalRow[]> {
        return db.storyFactProposal.findMany({ where: { workspaceId, bookId, status: 'PENDING', reason }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: PROPOSAL_SELECT });
    },
    /** Phase 4.4: which of these proposals are still PENDING (a continuity question's persist). */
    async pendingAmong(db: Db, workspaceId: string, bookId: string, ids: readonly string[]): Promise<string[]> {
        if (ids.length === 0) return [];
        const rows = await db.storyFactProposal.findMany({ where: { workspaceId, bookId, id: { in: [...ids] }, status: 'PENDING' }, take: ids.length, select: { id: true } });
        return rows.map((r) => r.id);
    },
    async countPendingByReason(db: Db, workspaceId: string, bookId: string): Promise<{ contradicted: number; noLongerStated: number }> {
        const rows = await db.storyFactProposal.groupBy({ by: ['reason'], where: { workspaceId, bookId, status: 'PENDING' }, _count: { _all: true }, orderBy: { reason: 'asc' }, take: 4 });
        const of = (r: string) => rows.find((x) => x.reason === r)?._count._all ?? 0;
        return { contradicted: of('CONTRADICTED'), noLongerStated: of('NO_LONGER_STATED') };
    },
    async listForBook(db: Db, workspaceId: string, bookId: string, status: FactProposalStatus, take: number): Promise<FactProposalRow[]> {
        return db.storyFactProposal.findMany({ where: { workspaceId, bookId, status }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: PROPOSAL_SELECT });
    },
    async countPending(db: Db, workspaceId: string, bookId: string): Promise<number> {
        return db.storyFactProposal.count({ where: { workspaceId, bookId, status: 'PENDING' } });
    },
    async find(db: Db, workspaceId: string, bookId: string, id: string): Promise<FactProposalRow | null> {
        return db.storyFactProposal.findFirst({ where: { workspaceId, bookId, id }, select: PROPOSAL_SELECT });
    },
    /** Decide a PENDING proposal, once. */
    async decide(db: Db, workspaceId: string, id: string, data: { status: Exclude<FactProposalStatus, 'PENDING'>; decidedById: string; at: Date }): Promise<boolean> {
        const r = await db.storyFactProposal.updateMany({ where: { workspaceId, id, status: 'PENDING' }, data: { status: data.status, decidedById: data.decidedById, decidedAt: data.at } });
        return r.count === 1;
    },
    /** Close every other PENDING proposal to invalidate a fact the author has just invalidated: it is settled the same way. */
    async settleOthersForFact(db: Db, workspaceId: string, factId: string, data: { decidedById: string; at: Date }): Promise<number> {
        const r = await db.storyFactProposal.updateMany({ where: { workspaceId, factId, status: 'PENDING' }, data: { status: 'INVALIDATED', decidedById: data.decidedById, decidedAt: data.at } });
        return r.count;
    },
    /**
     * Phase 4.2: close every other PENDING proposal a fact the author has just invalidated stands in (as the older or
     * the newer): a contradiction with a fact no longer live has nothing left to decide. Settled INVALIDATED where it was
     * the older, INVALIDATED_NEWER where it was the newer (4.1 left the second kind pending: its 4.H note).
     */
    async settleAllForFact(db: Db, workspaceId: string, factId: string, data: { decidedById: string; at: Date }): Promise<number> {
        const older = await db.storyFactProposal.updateMany({ where: { workspaceId, factId, status: 'PENDING' }, data: { status: 'INVALIDATED', decidedById: data.decidedById, decidedAt: data.at } });
        const newer = await db.storyFactProposal.updateMany({ where: { workspaceId, newerFactId: factId, status: 'PENDING', reason: 'CONTRADICTED' }, data: { status: 'INVALIDATED_NEWER', decidedById: data.decidedById, decidedAt: data.at } });
        return older.count + newer.count;
    },
};

export const EmbeddingTaskRepository = {
    /** DISCOVERY (outside RLS, ids only): the workspaces with tasks waiting, oldest task first. */
    /**
     * Up to `take` DISTINCT workspaces with tasks, the oldest task first (4.H-a). It read the `take` oldest TASKS and
     * kept their workspaces, so one workspace holding that many old tasks — one whose key cannot be unwrapped never
     * clears them — was the only workspace every tick, and every other workspace's tasks waited for ever.
     */
    async listDueWorkspaces(db: PrismaClient, take: number, workspaceIds?: readonly string[]): Promise<string[]> {
        const rows = await db.embeddingTask.groupBy({
            by: ['workspaceId'],
            where: workspaceIds ? { workspaceId: { in: [...workspaceIds] } } : {},
            _min: { createdAt: true },
            orderBy: [{ _min: { createdAt: 'asc' } }, { workspaceId: 'asc' }],
            take,
        });
        return rows.map((r) => r.workspaceId);
    },
    async listForWorkspace(db: Db, workspaceId: string, take: number): Promise<Array<{ id: string; sourceModel: string; sourceId: string; attempts: number; generation: number }>> {
        return db.embeddingTask.findMany({ where: { workspaceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: { id: true, sourceModel: true, sourceId: true, attempts: true, generation: true } });
    },
    /** Delete tasks, each only at the generation it was read at: one its row's change bumped since waits for the next tick. */
    async remove(db: Db, workspaceId: string, tasks: ReadonlyArray<{ id: string; generation: number }>): Promise<number> {
        if (tasks.length === 0) return 0;
        const r = await db.embeddingTask.deleteMany({ where: { workspaceId, OR: tasks.map((t) => ({ id: t.id, generation: t.generation })) } });
        return r.count;
    },
    async bumpAttempts(db: Db, workspaceId: string, ids: readonly string[]): Promise<void> {
        if (ids.length === 0) return;
        await db.embeddingTask.updateMany({ where: { workspaceId, id: { in: [...ids] } }, data: { attempts: { increment: 1 } } });
    },
};

/** The text an embedding task names, as its row stands now (decrypted here, under RLS), and the book it is filed under. */
export const EmbeddingSourceRepository = {
    async elements(db: Db, workspaceId: string, ids: readonly string[]) {
        if (ids.length === 0) return [];
        return db.bibleElement.findMany({
            where: { workspaceId, id: { in: [...ids] }, book: { deletedAt: null } },
            take: ids.length,
            select: { id: true, bookId: true, name: true, summary: true, fields: { select: { key: true, value: true }, orderBy: { order: 'asc' }, take: 60 } },
        });
    },
    async facts(db: Db, workspaceId: string, ids: readonly string[]) {
        if (ids.length === 0) return [];
        return db.storyFact.findMany({
            where: { workspaceId, id: { in: [...ids] } },
            take: ids.length,
            select: { id: true, bookId: true, subjectName: true, statement: true, source: { select: { library: { select: { bookId: true } } } } },
        });
    },
    async answers(db: Db, workspaceId: string, ids: readonly string[]) {
        if (ids.length === 0) return [];
        return db.answer.findMany({
            where: { workspaceId, id: { in: [...ids] }, status: 'ANSWERED' },
            take: ids.length,
            select: { id: true, text: true, choice: true, question: { select: { session: { select: { bookId: true } } } } },
        });
    },
};

/** An entry the backfill will read (4.H-b): its newest version, ids only. */
export interface BackfillEntry {
    kind: 'BIBLE_VERSION' | 'RELATION_VERSION';
    bookId: string;
    subjectId: string;
    versionId: string;
}

/**
 * THE BACKFILL OF BIBLES SAVED BEFORE 4.1 (Phase 4.H-b; D31, D32). An entry is NEVER EXTRACTED when it has at least
 * one version and no extraction row at all: since 4.1 every version's own transaction writes one (the outbox
 * trigger), so such an entry was last saved before 4.1. The backfill gives the NEWEST version of each one row, of
 * origin BACKFILL — never every historical version — and the extraction reads it whole (no baseline). Idempotent: an
 * entry with a row is never found again.
 */
export const FactBackfillRepository = {
    /**
     * DISCOVERY (outside RLS, ids only): workspaces with backfill work — an entry of a live book never extracted, or a
     * BACKFILL row due — in workspace order, `after` the cursor (or `upTo` it, for the wrap), at most `take`.
     */
    async listWorkspaces(db: PrismaClient, data: { now: Date; staleBefore: Date; take: number; after?: string; upTo?: string; workspaceIds?: readonly string[] }): Promise<Array<{ workspaceId: string }>> {
        const bound = data.upTo !== undefined ? Prisma.sql`"workspaceId" <= ${data.upTo}` : Prisma.sql`"workspaceId" > ${data.after ?? ''}`;
        const scope = data.workspaceIds ? Prisma.sql`AND "workspaceId" = ANY(${[...data.workspaceIds]}::text[])` : Prisma.empty;
        return db.$queryRaw<Array<{ workspaceId: string }>>(Prisma.sql`
            SELECT "workspaceId" FROM (
                SELECT e."workspaceId" FROM "BibleElement" e
                JOIN "Book" b ON b."workspaceId" = e."workspaceId" AND b."id" = e."bookId" AND b."deletedAt" IS NULL
                WHERE EXISTS (SELECT 1 FROM "BibleEntryVersion" v WHERE v."elementId" = e."id")
                  AND NOT EXISTS (SELECT 1 FROM "BibleFactExtraction" x WHERE x."workspaceId" = e."workspaceId" AND x."elementId" = e."id")
                UNION
                SELECT r."workspaceId" FROM "BibleRelation" r
                JOIN "Book" b ON b."workspaceId" = r."workspaceId" AND b."id" = r."bookId" AND b."deletedAt" IS NULL
                WHERE EXISTS (SELECT 1 FROM "BibleRelationVersion" v WHERE v."relationId" = r."id")
                  AND NOT EXISTS (SELECT 1 FROM "BibleFactExtraction" x WHERE x."workspaceId" = r."workspaceId" AND x."relationId" = r."id")
                UNION
                SELECT x."workspaceId" FROM "BibleFactExtraction" x
                WHERE x."origin" = 'BACKFILL'
                  AND (x."status" = 'PENDING' OR (x."status" = 'STOPPED' AND x."nextAttemptAt" <= ${data.now})
                       OR (x."status" = 'QUEUED' AND x."queuedAt" < ${data.staleBefore}) OR (x."status" = 'RUNNING' AND x."startedAt" < ${data.staleBefore}))
            ) w
            WHERE ${bound} ${scope}
            ORDER BY "workspaceId"
            LIMIT ${data.take}`);
    },
    /** A workspace's entries never extracted, the newest version of each (in its context), at most `take`. */
    async neverExtracted(db: Db, workspaceId: string, take: number): Promise<BackfillEntry[]> {
        if (take <= 0) return [];
        return db.$queryRaw<BackfillEntry[]>(Prisma.sql`
            SELECT * FROM (
                SELECT 'BIBLE_VERSION' AS "kind", e."bookId", e."id" AS "subjectId",
                       (SELECT v."id" FROM "BibleEntryVersion" v WHERE v."elementId" = e."id" ORDER BY v."versionNumber" DESC LIMIT 1) AS "versionId"
                FROM "BibleElement" e
                JOIN "Book" b ON b."workspaceId" = e."workspaceId" AND b."id" = e."bookId" AND b."deletedAt" IS NULL
                WHERE e."workspaceId" = ${workspaceId}
                  AND NOT EXISTS (SELECT 1 FROM "BibleFactExtraction" x WHERE x."workspaceId" = e."workspaceId" AND x."elementId" = e."id")
                UNION ALL
                SELECT 'RELATION_VERSION', r."bookId", r."id",
                       (SELECT v."id" FROM "BibleRelationVersion" v WHERE v."relationId" = r."id" ORDER BY v."versionNumber" DESC LIMIT 1)
                FROM "BibleRelation" r
                JOIN "Book" b ON b."workspaceId" = r."workspaceId" AND b."id" = r."bookId" AND b."deletedAt" IS NULL
                WHERE r."workspaceId" = ${workspaceId}
                  AND NOT EXISTS (SELECT 1 FROM "BibleFactExtraction" x WHERE x."workspaceId" = r."workspaceId" AND x."relationId" = r."id")
            ) n
            WHERE "versionId" IS NOT NULL
            ORDER BY "bookId", "kind", "subjectId"
            LIMIT ${take}`);
    },
    /** Give each entry its BACKFILL row (PENDING). A version that already has one (a race) is skipped. Returns how many were new. */
    async createRows(db: Db, workspaceId: string, entries: readonly BackfillEntry[]): Promise<number> {
        if (entries.length === 0) return 0;
        const r = await db.bibleFactExtraction.createMany({
            data: entries.map((e) => ({
                workspaceId,
                bookId: e.bookId,
                kind: e.kind,
                origin: 'BACKFILL',
                ...(e.kind === 'BIBLE_VERSION' ? { elementId: e.subjectId, bibleVersionId: e.versionId } : { relationId: e.subjectId, relationVersionId: e.versionId }),
            })),
            skipDuplicates: true,
        });
        return r.count;
    },
    /** A workspace's due BACKFILL rows, oldest first, at most `take` (in its context). */
    async listDue(db: Db, workspaceId: string, window: ExtractionDueWindow, take: number): Promise<DueExtraction[]> {
        if (take <= 0) return [];
        return db.bibleFactExtraction.findMany({ where: { workspaceId, ...dueWhere(window, 'BACKFILL') }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: DUE_SELECT });
    },
    /**
     * A book's backfill, for the Continuity page: entries never extracted (no row yet), and the BACKFILL rows by how
     * they stand — READ (DONE, or SKIPPED because a later save's extraction covers it or the entry is gone), NOT READ
     * (FAILED, or SKIPPED because no member may act for it), and waiting (the rest). Counts only.
     */
    async progressForBook(db: Db, workspaceId: string, bookId: string): Promise<{ waiting: number; read: number; notRead: number; queued: number }> {
        const rows = await db.$queryRaw<Array<{ waiting: bigint; read: bigint; notRead: bigint; queued: bigint }>>(Prisma.sql`
            SELECT
              (SELECT count(*) FROM "BibleElement" e WHERE e."workspaceId" = ${workspaceId} AND e."bookId" = ${bookId}
                 AND EXISTS (SELECT 1 FROM "BibleEntryVersion" v WHERE v."elementId" = e."id")
                 AND NOT EXISTS (SELECT 1 FROM "BibleFactExtraction" x WHERE x."workspaceId" = e."workspaceId" AND x."elementId" = e."id"))
              + (SELECT count(*) FROM "BibleRelation" r WHERE r."workspaceId" = ${workspaceId} AND r."bookId" = ${bookId}
                 AND EXISTS (SELECT 1 FROM "BibleRelationVersion" v WHERE v."relationId" = r."id")
                 AND NOT EXISTS (SELECT 1 FROM "BibleFactExtraction" x WHERE x."workspaceId" = r."workspaceId" AND x."relationId" = r."id")) AS "waiting",
              count(*) FILTER (WHERE x."status" = 'DONE' OR (x."status" = 'SKIPPED' AND x."outcome" IN ('SUPERSEDED', 'SUBJECT_GONE', 'BOOK_DELETED'))) AS "read",
              count(*) FILTER (WHERE x."status" = 'FAILED' OR (x."status" = 'SKIPPED' AND x."outcome" NOT IN ('SUPERSEDED', 'SUBJECT_GONE', 'BOOK_DELETED'))) AS "notRead",
              count(*) AS "queued"
            FROM "BibleFactExtraction" x WHERE x."workspaceId" = ${workspaceId} AND x."bookId" = ${bookId} AND x."origin" = 'BACKFILL'`);
        const r = rows[0];
        return { waiting: Number(r?.waiting ?? 0), read: Number(r?.read ?? 0), notRead: Number(r?.notRead ?? 0), queued: Number(r?.queued ?? 0) };
    },
};
