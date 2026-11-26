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
import type { FactExtractionOutcome, FactExtractionStatus, FactProposalStatus } from '@/lib/facts/vocabulary';

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

/** The lists interleaved, first of each, then second of each…, cut at `take`. */
export function roundRobin<T>(lists: readonly (readonly T[])[], take: number): T[] {
    const out: T[] = [];
    for (let i = 0; out.length < take; i++) {
        let any = false;
        for (const l of lists) {
            if (i < l.length) {
                any = true;
                out.push(l[i]);
                if (out.length >= take) break;
            }
        }
        if (!any) break;
    }
    return out;
}

function dueWhere(data: ExtractionDueWindow): Prisma.BibleFactExtractionWhereInput {
    return {
        OR: [
            { status: 'PENDING', createdAt: { lt: data.settledBefore } },
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
    async listDue(db: PrismaClient, data: ExtractionDueWindow & { take: number; workspaceIds?: readonly string[] }): Promise<DueExtraction[]> {
        const scope = data.workspaceIds ? { workspaceId: { in: [...data.workspaceIds] } } : {};
        const groups = await db.bibleFactExtraction.groupBy({
            by: ['workspaceId'],
            where: { ...scope, ...dueWhere(data) },
            _min: { createdAt: true },
            orderBy: [{ _min: { createdAt: 'asc' } }, { workspaceId: 'asc' }],
            take: data.take,
        });
        if (groups.length === 0) return [];
        const share = Math.max(1, Math.ceil(data.take / groups.length));
        const lists: DueExtraction[][] = [];
        for (const g of groups) {
            // One bounded read per workspace with due rows (at most `take` of them): the fair share's own shape.
            lists.push(
                await db.bibleFactExtraction.findMany({
                    where: { workspaceId: g.workspaceId, ...dueWhere(data) },
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    take: share,
                    select: DUE_SELECT,
                }),
            );
        }
        return roundRobin(lists, data.take);
    },
    /**
     * Mark a due row QUEUED, counting the attempt — only while it is STILL due by the same window discovery used,
     * asked in the same statement: a row another dispatcher tick queued meanwhile (and a worker may have claimed) is
     * fresh, not stale, and is left to its worker. Never steal a live claim: its call is already being paid for.
     */
    async markQueued(db: Db, workspaceId: string, id: string, at: Date, due: ExtractionDueWindow): Promise<boolean> {
        const r = await db.bibleFactExtraction.updateMany({
            where: { workspaceId, id, ...dueWhere(due) },
            data: { status: 'QUEUED', queuedAt: at, startedAt: null, attempts: { increment: 1 } },
        });
        return r.count === 1;
    },
    /**
     * The workspace's month has no room (the ledger's own reading, asked by the dispatcher): its due rows WAIT,
     * STOPPED CEILING, looked at again at `until`, no attempt counted. A stale claim among them is ended with it.
     * Only while still due (the same window, the same statement).
     */
    async deferAtCeiling(db: Db, workspaceId: string, ids: readonly string[], due: ExtractionDueWindow, until: Date): Promise<number> {
        if (ids.length === 0) return 0;
        const r = await db.bibleFactExtraction.updateMany({
            where: { workspaceId, id: { in: [...ids] }, ...dueWhere(due) },
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
            },
        });
        return r.count === 1;
    },
    /** What a call cost, counted whatever became of the run (#57 item 5's lesson, applied here from the start). */
    async addCost(db: Db, workspaceId: string, id: string, costMicroUsd: number): Promise<void> {
        if (costMicroUsd <= 0) return;
        await db.bibleFactExtraction.updateMany({ where: { workspaceId, id }, data: { costMicroUsd: { increment: BigInt(Math.round(costMicroUsd)) } } });
    },
    /** The element's newest extracted version (its BASELINE), other than `exceptVersionId`. */
    async baselineForElement(db: Db, workspaceId: string, elementId: string, exceptVersionId: string): Promise<string | null> {
        const row = await db.bibleFactExtraction.findFirst({
            where: { workspaceId, elementId, status: 'DONE', NOT: { bibleVersionId: exceptVersionId } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { bibleVersionId: true },
        });
        return row?.bibleVersionId ?? null;
    },
    async baselineForRelation(db: Db, workspaceId: string, relationId: string, exceptVersionId: string): Promise<string | null> {
        const row = await db.bibleFactExtraction.findFirst({
            where: { workspaceId, relationId, status: 'DONE', NOT: { relationVersionId: exceptVersionId } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { relationVersionId: true },
        });
        return row?.relationVersionId ?? null;
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
    async listDueWorkspaces(db: PrismaClient, take: number, workspaceIds?: readonly string[]): Promise<string[]> {
        const rows = await db.embeddingTask.findMany({ where: workspaceIds ? { workspaceId: { in: [...workspaceIds] } } : {}, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: { workspaceId: true } });
        return [...new Set(rows.map((r) => r.workspaceId))];
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
