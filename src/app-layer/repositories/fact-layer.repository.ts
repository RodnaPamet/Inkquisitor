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
import type { Prisma, PrismaClient } from '@prisma/client';
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

const PROPOSAL_SELECT = { id: true, bookId: true, factId: true, newerFactId: true, reason: true, basis: true, status: true, decidedAt: true, createdAt: true } as const satisfies Prisma.StoryFactProposalSelect;
export type FactProposalRow = Prisma.StoryFactProposalGetPayload<{ select: typeof PROPOSAL_SELECT }>;

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
     * DISCOVERY (outside RLS, ids only): due extractions across workspaces, oldest first — PENDING ones settled
     * for `settledBefore`, STOPPED ones whose next attempt is due, and QUEUED or RUNNING ones with no sign of life
     * since `staleBefore` (a lost job or a dead worker).
     */
    async listDue(db: PrismaClient, data: { now: Date; settledBefore: Date; staleBefore: Date; take: number; workspaceIds?: readonly string[] }): Promise<Array<{ id: string; workspaceId: string; attempts: number }>> {
        return db.bibleFactExtraction.findMany({
            where: {
                ...(data.workspaceIds ? { workspaceId: { in: [...data.workspaceIds] } } : {}),
                OR: [
                    { status: 'PENDING', createdAt: { lt: data.settledBefore } },
                    { status: 'STOPPED', nextAttemptAt: { lte: data.now } },
                    { status: 'QUEUED', queuedAt: { lt: data.staleBefore } },
                    { status: 'RUNNING', startedAt: { lt: data.staleBefore } },
                ],
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: data.take,
            select: { id: true, workspaceId: true, attempts: true },
        });
    },
    /** Mark a due row QUEUED (from what the dispatcher saw), counting the attempt. */
    async markQueued(db: Db, workspaceId: string, id: string, at: Date): Promise<boolean> {
        const r = await db.bibleFactExtraction.updateMany({
            where: { workspaceId, id, status: { in: ['PENDING', 'STOPPED', 'QUEUED', 'RUNNING'] } },
            data: { status: 'QUEUED', queuedAt: at, startedAt: null, attempts: { increment: 1 } },
        });
        return r.count === 1;
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
        },
    ): Promise<boolean> {
        const r = await db.bibleFactExtraction.updateMany({
            where: { workspaceId, id, status: { in: data.from }, ...(data.claim ? { startedAt: data.claim } : {}) },
            data: {
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
        rows: ReadonlyArray<{ bookId: string; factId: string; newerFactId: string | null; reason: 'CONTRADICTED' | 'NO_LONGER_STATED'; basis: 'RULE' | 'MODEL' | 'TEXT'; extractionId: string }>,
    ): Promise<number> {
        if (rows.length === 0) return 0;
        const r = await db.storyFactProposal.createMany({ data: rows.map((x) => ({ workspaceId, ...x })), skipDuplicates: true });
        return r.count;
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
};

export const EmbeddingTaskRepository = {
    /** DISCOVERY (outside RLS, ids only): the workspaces with tasks waiting, oldest task first. */
    async listDueWorkspaces(db: PrismaClient, take: number, workspaceIds?: readonly string[]): Promise<string[]> {
        const rows = await db.embeddingTask.findMany({ where: workspaceIds ? { workspaceId: { in: [...workspaceIds] } } : {}, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: { workspaceId: true } });
        return [...new Set(rows.map((r) => r.workspaceId))];
    },
    async listForWorkspace(db: Db, workspaceId: string, take: number): Promise<Array<{ id: string; sourceModel: string; sourceId: string; attempts: number }>> {
        return db.embeddingTask.findMany({ where: { workspaceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: { id: true, sourceModel: true, sourceId: true, attempts: true } });
    },
    async remove(db: Db, workspaceId: string, ids: readonly string[]): Promise<number> {
        if (ids.length === 0) return 0;
        const r = await db.embeddingTask.deleteMany({ where: { workspaceId, id: { in: [...ids] } } });
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
