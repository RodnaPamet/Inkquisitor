/**
 * The source library's tables (Phase 4.0, D23 and D26): libraries, sources,
 * chunks, facts, a book's series opt-ins and its overrides. Workspace-scoped:
 * every query runs inside `runInWorkspaceContext` AND filters by
 * `workspaceId`. No authorization and no validation here: the usecases
 * (`src/app-layer/usecases/source-*.ts`) ask permission, validate and sanitise
 * first.
 *
 * The text columns are sealed and opened by the field-encryption extension;
 * this module reads and writes plaintext and never filters on them. A fact is
 * inserted once and then only DECIDED (a trigger refuses any other change).
 * Every list is bounded by a `take` its caller chooses.
 */
import type { Prisma, SourceFormat, SourceLibraryScope, SourceStatus, StoryFactStatus } from '@prisma/client';

type Db = Prisma.TransactionClient;

const LIBRARY_SELECT = { id: true, scope: true, bookId: true } as const satisfies Prisma.SourceLibrarySelect;
export type SourceLibraryRow = Prisma.SourceLibraryGetPayload<{ select: typeof LIBRARY_SELECT }>;

const SOURCE_SELECT = {
    id: true,
    libraryId: true,
    filename: true,
    format: true,
    byteLength: true,
    contentHash: true,
    version: true,
    supersedesId: true,
    status: true,
    outcome: true,
    chunkCount: true,
    chunksDone: true,
    factCount: true,
    estimateMicroUsd: true,
    worstCaseMicroUsd: true,
    budgetMicroUsd: true,
    spentMicroUsd: true,
    metrics: true,
    promptVersion: true,
    requestedById: true,
    createdAt: true,
    startedAt: true,
    heartbeatAt: true,
    finishedAt: true,
    library: { select: LIBRARY_SELECT },
} as const satisfies Prisma.SourceSelect;
export type SourceRow = Prisma.SourceGetPayload<{ select: typeof SOURCE_SELECT }>;

const CHUNK_SELECT = { id: true, sourceId: true, position: true, headingPath: true, text: true, startOffset: true, endOffset: true, tokenEstimate: true, extractedAt: true } as const satisfies Prisma.SourceChunkSelect;
export type SourceChunkRow = Prisma.SourceChunkGetPayload<{ select: typeof CHUNK_SELECT }>;

const FACT_SELECT = {
    id: true,
    sourceId: true,
    chunkId: true,
    position: true,
    subjectName: true,
    subjectElementId: true,
    predicate: true,
    objectElementId: true,
    objectLiteral: true,
    statement: true,
    quote: true,
    quoteStart: true,
    quoteEnd: true,
    storyTimeFrom: true,
    storyTimeTo: true,
    statedAt: true,
    supersededAt: true,
    status: true,
    flags: true,
    decidedById: true,
    decidedAt: true,
    carriedFromFactId: true,
    createdAt: true,
} as const satisfies Prisma.StoryFactSelect;
type RawFactRow = Prisma.StoryFactGetPayload<{ select: typeof FACT_SELECT }>;
/**
 * A SOURCE fact (Phase 4.0): its source and passage are set. Every read below names
 * `sourceKind: 'SOURCE_CHUNK'`, so a bible fact (Phase 4.1, no source) is never read,
 * decided or bulk-confirmed through this repository (`sourceFacts` drops one defensively).
 */
export type StoryFactRow = Omit<RawFactRow, 'sourceId' | 'chunkId'> & { sourceId: string; chunkId: string };

const SOURCE_KIND = { sourceKind: 'SOURCE_CHUNK' } as const;

function sourceFacts(rows: readonly RawFactRow[]): StoryFactRow[] {
    const out: StoryFactRow[] = [];
    for (const r of rows) if (r.sourceId !== null && r.chunkId !== null) out.push({ ...r, sourceId: r.sourceId, chunkId: r.chunkId });
    return out;
}

export const SourceLibraryRepository = {
    async findForBook(db: Db, workspaceId: string, bookId: string): Promise<SourceLibraryRow | null> {
        return db.sourceLibrary.findFirst({ where: { workspaceId, bookId, scope: 'BOOK' }, select: LIBRARY_SELECT });
    },
    async findSeries(db: Db, workspaceId: string): Promise<SourceLibraryRow | null> {
        return db.sourceLibrary.findFirst({ where: { workspaceId, scope: 'SERIES' }, select: LIBRARY_SELECT });
    },
    async create(db: Db, workspaceId: string, data: { scope: SourceLibraryScope; bookId: string | null }): Promise<SourceLibraryRow> {
        return db.sourceLibrary.create({ data: { workspaceId, scope: data.scope, bookId: data.bookId }, select: LIBRARY_SELECT });
    },
    /** Serialises the writes to one library (an upload's count and its duplicate check). */
    async lock(db: Db, key: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'source-library:' + key}))`;
    },
};

export const SourceRepository = {
    async find(db: Db, workspaceId: string, id: string): Promise<SourceRow | null> {
        return db.source.findFirst({ where: { workspaceId, id }, select: SOURCE_SELECT });
    },
    async listForLibrary(db: Db, workspaceId: string, libraryId: string, take: number): Promise<SourceRow[]> {
        return db.source.findMany({ where: { workspaceId, libraryId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: SOURCE_SELECT });
    },
    async listByIds(db: Db, workspaceId: string, ids: readonly string[]): Promise<SourceRow[]> {
        if (ids.length === 0) return [];
        return db.source.findMany({ where: { workspaceId, id: { in: [...ids] } }, take: ids.length, select: SOURCE_SELECT });
    },
    async countForLibrary(db: Db, workspaceId: string, libraryId: string): Promise<number> {
        return db.source.count({ where: { workspaceId, libraryId } });
    },
    async findByContent(db: Db, workspaceId: string, libraryId: string, contentHash: string): Promise<{ id: string } | null> {
        return db.source.findFirst({ where: { workspaceId, libraryId, contentHash }, select: { id: true } });
    },
    async create(
        db: Db,
        workspaceId: string,
        data: {
            libraryId: string;
            filename: string;
            format: SourceFormat;
            byteLength: number;
            contentHash: string;
            version: number;
            supersedesId: string | null;
            chunkCount: number;
            estimateMicroUsd: number;
            worstCaseMicroUsd: number;
            requestedById: string | null;
        },
    ): Promise<{ id: string }> {
        return db.source.create({
            data: {
                workspaceId,
                libraryId: data.libraryId,
                filename: data.filename,
                format: data.format,
                byteLength: data.byteLength,
                contentHash: data.contentHash,
                version: data.version,
                supersedesId: data.supersedesId,
                chunkCount: data.chunkCount,
                estimateMicroUsd: BigInt(data.estimateMicroUsd),
                worstCaseMicroUsd: BigInt(data.worstCaseMicroUsd),
                requestedById: data.requestedById,
            },
            select: { id: true },
        });
    },
    /** Queue it (the author confirmed the cost): only from ESTIMATED or STOPPED, or a FAILED / stale row. Its heartbeat starts now: a queue left unclaimed past `STALE_INGEST_MS` reads CLAIM_EXPIRED. */
    async queue(db: Db, workspaceId: string, id: string, data: { budgetMicroUsd: number; promptVersion: string; requestedById: string; now?: Date }): Promise<number> {
        const r = await db.source.updateMany({
            where: { workspaceId, id, status: { in: ['ESTIMATED', 'STOPPED', 'FAILED', 'QUEUED', 'RUNNING'] } },
            data: {
                status: 'QUEUED',
                outcome: null,
                budgetMicroUsd: BigInt(data.budgetMicroUsd),
                promptVersion: data.promptVersion,
                requestedById: data.requestedById,
                startedAt: null,
                heartbeatAt: data.now ?? new Date(),
                finishedAt: null,
            },
        });
        return r.count;
    },
    /**
     * QUEUED → RUNNING, once: of two workers, one claims it. Returns the claim (its `startedAt`), which every
     * later write of that worker names: a source queued again and claimed by another worker (a stale claim
     * re-dispatched) no longer matches it, so the first worker writes nothing more.
     */
    async claim(db: Db, workspaceId: string, id: string, now: Date): Promise<Date | null> {
        const r = await db.source.updateMany({ where: { workspaceId, id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: now, heartbeatAt: now } });
        return r.count === 1 ? now : null;
    },
    /** A sign of life from the claim's worker (between chunks, while it embeds or waits). */
    async touch(db: Db, workspaceId: string, id: string, claim: Date): Promise<boolean> {
        const r = await db.source.updateMany({ where: { workspaceId, id, status: 'RUNNING', startedAt: claim }, data: { heartbeatAt: new Date() } });
        return r.count === 1;
    },
    /** A chunk's facts are in: the cursor, the counts and the spend move, while it is still RUNNING under this claim. */
    async advance(db: Db, workspaceId: string, id: string, claim: Date, data: { chunksDone: number; facts: number; spentMicroUsd: number }): Promise<boolean> {
        const r = await db.source.updateMany({
            where: { workspaceId, id, status: 'RUNNING', startedAt: claim },
            data: {
                chunksDone: { increment: data.chunksDone },
                factCount: { increment: data.facts },
                spentMicroUsd: { increment: BigInt(Math.max(0, Math.round(data.spentMicroUsd))) },
                heartbeatAt: new Date(),
            },
        });
        return r.count === 1;
    },
    /** End or pause it (from RUNNING or QUEUED, or any status for an enqueue failure / a stale claim); a worker that claimed it names its claim. */
    async finish(db: Db, workspaceId: string, id: string, data: { status: SourceStatus; outcome: string; metrics: Prisma.InputJsonValue; from: SourceStatus[]; finishedAt: Date; claim?: Date }): Promise<boolean> {
        const r = await db.source.updateMany({
            where: { workspaceId, id, status: { in: data.from }, ...(data.claim ? { startedAt: data.claim } : {}) },
            data: { status: data.status, outcome: data.outcome, metrics: data.metrics, finishedAt: data.finishedAt },
        });
        return r.count === 1;
    },
    async delete(db: Db, workspaceId: string, id: string): Promise<number> {
        const r = await db.source.deleteMany({ where: { workspaceId, id } });
        return r.count;
    },
    /** Serialises one source's queueing, ingestion steps and removal. */
    async lock(db: Db, id: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'source:' + id}))`;
    },
};

export const SourceChunkRepository = {
    async createMany(db: Db, workspaceId: string, sourceId: string, rows: ReadonlyArray<{ position: number; headingPath: string | null; text: string; startOffset: number; endOffset: number; tokenEstimate: number }>): Promise<void> {
        if (rows.length === 0) return;
        await db.sourceChunk.createMany({
            data: rows.map((r) => ({ workspaceId, sourceId, position: r.position, headingPath: r.headingPath, text: r.text, startOffset: r.startOffset, endOffset: r.endOffset, tokenEstimate: r.tokenEstimate })),
        });
    },
    /** The next chunks whose facts are not yet extracted, in order. */
    async listPending(db: Db, workspaceId: string, sourceId: string, take: number): Promise<SourceChunkRow[]> {
        return db.sourceChunk.findMany({ where: { workspaceId, sourceId, extractedAt: null }, orderBy: { position: 'asc' }, take, select: CHUNK_SELECT });
    },
    async countPending(db: Db, workspaceId: string, sourceId: string): Promise<number> {
        return db.sourceChunk.count({ where: { workspaceId, sourceId, extractedAt: null } });
    },
    /** A page of a source's chunks in order (embedding, the estimate of a resume). */
    async listForSource(db: Db, workspaceId: string, sourceId: string, afterPosition: number, take: number): Promise<SourceChunkRow[]> {
        return db.sourceChunk.findMany({ where: { workspaceId, sourceId, position: { gt: afterPosition } }, orderBy: { position: 'asc' }, take, select: CHUNK_SELECT });
    },
    async listByIds(db: Db, workspaceId: string, ids: readonly string[]): Promise<SourceChunkRow[]> {
        if (ids.length === 0) return [];
        return db.sourceChunk.findMany({ where: { workspaceId, id: { in: [...ids] } }, take: ids.length, select: CHUNK_SELECT });
    },
    /** Chunks of these sources, in source then position order (the retriever's bounded lexical scan). */
    async listForSources(db: Db, workspaceId: string, sourceIds: readonly string[], take: number): Promise<SourceChunkRow[]> {
        if (sourceIds.length === 0) return [];
        return db.sourceChunk.findMany({ where: { workspaceId, sourceId: { in: [...sourceIds] } }, orderBy: [{ sourceId: 'asc' }, { position: 'asc' }], take, select: CHUNK_SELECT });
    },
    async markExtracted(db: Db, workspaceId: string, id: string, at: Date): Promise<boolean> {
        const r = await db.sourceChunk.updateMany({ where: { workspaceId, id, extractedAt: null }, data: { extractedAt: at } });
        return r.count === 1;
    },
    /** Mark a chunk read that can never be read, with why (#57 item 2): the rest of the source completes. */
    async markUnreadable(db: Db, workspaceId: string, id: string, at: Date, reason: 'REPEATS_PROMPT'): Promise<boolean> {
        const r = await db.sourceChunk.updateMany({ where: { workspaceId, id, extractedAt: null }, data: { extractedAt: at, unreadableReason: reason } });
        return r.count === 1;
    },
};

export interface FactViewFilter {
    sourceIds: readonly string[];
    status?: StoryFactStatus;
    /** Keyset: facts after this (chunk position order is by chunk id then position). */
    after?: { chunkId: string; position: number } | null;
    take: number;
}

/** A live bible fact (Phase 4.1, D27) as the resolver, the frontier's check and the retriever read it. */
const BIBLE_FACT_SELECT = {
    id: true,
    sourceKind: true,
    bookId: true,
    elementId: true,
    relationId: true,
    bibleVersionId: true,
    relationVersionId: true,
    dedupeKey: true,
    subjectName: true,
    subjectElementId: true,
    predicate: true,
    objectElementId: true,
    objectLiteral: true,
    statement: true,
    quote: true,
    storyTimeFrom: true,
    storyTimeTo: true,
    statedAt: true,
    supersededAt: true,
} as const satisfies Prisma.StoryFactSelect;
export type BibleFactRow = Prisma.StoryFactGetPayload<{ select: typeof BIBLE_FACT_SELECT }>;

const BIBLE_KINDS = { sourceKind: { in: ['BIBLE_VERSION', 'RELATION_VERSION'] } } as const satisfies Prisma.StoryFactWhereInput;

/** One fact drawn from an accepted version: CONFIRMED and automatic (D27). The text is `sanitiseFactForStorage`'s. */
export interface BibleFactInsert {
    sourceKind: 'BIBLE_VERSION' | 'RELATION_VERSION';
    bookId: string;
    elementId: string | null;
    relationId: string | null;
    bibleVersionId: string | null;
    relationVersionId: string | null;
    dedupeKey: string;
    position: number;
    subjectName: string;
    subjectElementId: string | null;
    predicate: string;
    objectElementId: string | null;
    objectLiteral: string | null;
    statement: string;
    quote: string;
    quoteStart: number;
    quoteEnd: number;
    storyTimeFrom: string | null;
    storyTimeTo: string | null;
    flags: string[];
}

export const StoryFactRepository = {
    async createMany(
        db: Db,
        workspaceId: string,
        rows: ReadonlyArray<{
            sourceId: string;
            chunkId: string;
            position: number;
            subjectName: string;
            subjectElementId: string | null;
            predicate: string;
            objectElementId: string | null;
            objectLiteral: string | null;
            statement: string;
            quote: string;
            quoteStart: number;
            quoteEnd: number;
            storyTimeFrom: string | null;
            storyTimeTo: string | null;
            flags: string[];
            status: StoryFactStatus;
            decidedById: string | null;
            decidedAt: Date | null;
            carriedFromFactId: string | null;
        }>,
    ): Promise<void> {
        if (rows.length === 0) return;
        await db.storyFact.createMany({
            data: rows.map((r) => ({
                workspaceId,
                sourceId: r.sourceId,
                chunkId: r.chunkId,
                position: r.position,
                subjectName: r.subjectName,
                subjectElementId: r.subjectElementId,
                predicate: r.predicate,
                objectElementId: r.objectElementId,
                objectLiteral: r.objectLiteral,
                statement: r.statement,
                quote: r.quote,
                quoteStart: r.quoteStart,
                quoteEnd: r.quoteEnd,
                storyTimeFrom: r.storyTimeFrom,
                storyTimeTo: r.storyTimeTo,
                flags: r.flags,
                status: r.status,
                decidedById: r.decidedById,
                decidedAt: r.decidedAt,
                carriedFromFactId: r.carriedFromFactId,
            })),
        });
    },
    async find(db: Db, workspaceId: string, id: string): Promise<StoryFactRow | null> {
        const row = await db.storyFact.findFirst({ where: { workspaceId, id, ...SOURCE_KIND }, select: FACT_SELECT });
        return row ? (sourceFacts([row])[0] ?? null) : null;
    },
    async listByIds(db: Db, workspaceId: string, ids: readonly string[]): Promise<StoryFactRow[]> {
        if (ids.length === 0) return [];
        return sourceFacts(await db.storyFact.findMany({ where: { workspaceId, id: { in: [...ids] }, ...SOURCE_KIND }, take: ids.length, select: FACT_SELECT }));
    },
    /** A view's facts: these sources, optionally one status, in chunk order, keyset after a fact. */
    async listForView(db: Db, workspaceId: string, filter: FactViewFilter): Promise<StoryFactRow[]> {
        if (filter.sourceIds.length === 0) return [];
        const after = filter.after ? { OR: [{ chunkId: { gt: filter.after.chunkId } }, { chunkId: filter.after.chunkId, position: { gt: filter.after.position } }] } : {};
        return sourceFacts(
            await db.storyFact.findMany({
                where: { workspaceId, sourceId: { in: [...filter.sourceIds] }, ...SOURCE_KIND, supersededAt: null, ...(filter.status ? { status: filter.status } : {}), ...after },
                orderBy: [{ chunkId: 'asc' }, { position: 'asc' }],
                take: filter.take,
                select: FACT_SELECT,
            }),
        );
    },
    async countByStatus(db: Db, workspaceId: string, sourceIds: readonly string[]): Promise<Array<{ status: StoryFactStatus; count: number }>> {
        if (sourceIds.length === 0) return [];
        const rows = await db.storyFact.groupBy({ by: ['status'], where: { workspaceId, sourceId: { in: [...sourceIds] }, ...SOURCE_KIND, supersededAt: null }, _count: { _all: true } });
        return rows.map((r) => ({ status: r.status, count: r._count._all }));
    },
    /**
     * The decided facts of a source (a re-upload's carry-over). A fact the author INVALIDATED (4.1: `supersededAt`, a
     * proposal decided) is not among them: its CONFIRMED status is the decision the author has since withdrawn, and
     * carrying it would bring the claim back live in the next version with nobody deciding (rule 1). The same claim
     * in the new version is PENDING, for the author to decide again.
     */
    async listDecidedForSource(db: Db, workspaceId: string, sourceId: string, take: number): Promise<StoryFactRow[]> {
        return sourceFacts(await db.storyFact.findMany({ where: { workspaceId, sourceId, ...SOURCE_KIND, status: { in: ['CONFIRMED', 'REJECTED'] }, supersededAt: null }, orderBy: [{ chunkId: 'asc' }, { position: 'asc' }], take, select: FACT_SELECT }));
    },
    /** The confirmed facts of these sources (the frontier's check and the retriever). */
    async listConfirmed(db: Db, workspaceId: string, sourceIds: readonly string[], take: number): Promise<StoryFactRow[]> {
        if (sourceIds.length === 0) return [];
        return sourceFacts(await db.storyFact.findMany({ where: { workspaceId, sourceId: { in: [...sourceIds] }, ...SOURCE_KIND, status: 'CONFIRMED', supersededAt: null }, orderBy: [{ chunkId: 'asc' }, { position: 'asc' }], take, select: FACT_SELECT }));
    },
    /** Decide a fact (or change its decision). */
    async decide(db: Db, workspaceId: string, id: string, data: { status: 'CONFIRMED' | 'REJECTED'; decidedById: string; decidedAt: Date }): Promise<boolean> {
        const r = await db.storyFact.updateMany({ where: { workspaceId, id, ...SOURCE_KIND, supersededAt: null }, data: { status: data.status, decidedById: data.decidedById, decidedAt: data.decidedAt } });
        return r.count === 1;
    },
    /** Write a version's new facts (the caller holds the book's fact lock and has resolved them: one live fact per claim). */
    async createBibleFacts(db: Db, workspaceId: string, rows: readonly BibleFactInsert[], at: Date): Promise<Array<{ id: string; dedupeKey: string | null }>> {
        const out: Array<{ id: string; dedupeKey: string | null }> = [];
        for (const r of rows) {
            out.push(
                await db.storyFact.create({
                    data: {
                        workspaceId,
                        sourceKind: r.sourceKind,
                        bookId: r.bookId,
                        elementId: r.elementId,
                        relationId: r.relationId,
                        bibleVersionId: r.bibleVersionId,
                        relationVersionId: r.relationVersionId,
                        automatic: true,
                        dedupeKey: r.dedupeKey,
                        position: r.position,
                        subjectName: r.subjectName,
                        subjectElementId: r.subjectElementId,
                        predicate: r.predicate,
                        objectElementId: r.objectElementId,
                        objectLiteral: r.objectLiteral,
                        statement: r.statement,
                        quote: r.quote,
                        quoteStart: r.quoteStart,
                        quoteEnd: r.quoteEnd,
                        storyTimeFrom: r.storyTimeFrom,
                        storyTimeTo: r.storyTimeTo,
                        flags: r.flags,
                        status: 'CONFIRMED',
                        decidedAt: at,
                    },
                    select: { id: true, dedupeKey: true },
                }),
            );
        }
        return out;
    },
    /** Confirm these facts, each only while it is PENDING and unflagged (the bulk confirm). Returns how many moved. */
    async confirmPending(db: Db, workspaceId: string, ids: readonly string[], data: { decidedById: string; decidedAt: Date }): Promise<number> {
        if (ids.length === 0) return 0;
        const r = await db.storyFact.updateMany({
            where: { workspaceId, id: { in: [...ids] }, ...SOURCE_KIND, status: 'PENDING', supersededAt: null, flags: { isEmpty: true } },
            data: { status: 'CONFIRMED', decidedById: data.decidedById, decidedAt: data.decidedAt },
        });
        return r.count;
    },
};

/** Bible facts (Phase 4.1, D27): read by the bible fact job, the frontier, the retriever and the review; their one write here is the author's invalidation. Inserts are `StoryFactRepository.createBibleFacts` (the sanitiser guard). */
export const BibleFactRepository = {
    /** A book's live bible facts about these subject elements (both an element's and a relation's), oldest first. */
    async listLiveAbout(db: Db, workspaceId: string, bookId: string, subjectElementIds: readonly string[], take: number): Promise<BibleFactRow[]> {
        if (subjectElementIds.length === 0) return [];
        return db.storyFact.findMany({
            where: { workspaceId, bookId, ...BIBLE_KINDS, supersededAt: null, subjectElementId: { in: [...subjectElementIds] } },
            orderBy: [{ statedAt: 'asc' }, { id: 'asc' }],
            take,
            select: BIBLE_FACT_SELECT,
        });
    },
    /** The live facts one entry (an element, or a relation) owns, oldest first. */
    async listLiveOwnedBy(db: Db, workspaceId: string, bookId: string, owner: { elementId: string } | { relationId: string }, take: number): Promise<BibleFactRow[]> {
        return db.storyFact.findMany({ where: { workspaceId, bookId, ...BIBLE_KINDS, supersededAt: null, ...owner }, orderBy: [{ statedAt: 'asc' }, { id: 'asc' }], take, select: BIBLE_FACT_SELECT });
    },
    /** A book's live bible facts (the retriever's ranked pool), newest first. */
    async listLiveForBook(db: Db, workspaceId: string, bookId: string, take: number): Promise<BibleFactRow[]> {
        return db.storyFact.findMany({ where: { workspaceId, bookId, ...BIBLE_KINDS, supersededAt: null }, orderBy: [{ statedAt: 'desc' }, { id: 'asc' }], take, select: BIBLE_FACT_SELECT });
    },
    /** Facts of any kind by id, scoped to a book's bible facts or the given sources (proposals name both kinds). */
    async listAnyByIds(db: Db, workspaceId: string, ids: readonly string[]): Promise<Array<BibleFactRow & { sourceId: string | null; chunkId: string | null; status: StoryFactStatus }>> {
        if (ids.length === 0) return [];
        return db.storyFact.findMany({ where: { workspaceId, id: { in: [...ids] } }, take: ids.length, select: { ...BIBLE_FACT_SELECT, sourceId: true, chunkId: true, status: true } });
    },
    /** Invalidate a live fact, once (the author's INVALIDATE decision on a proposal). */
    async supersede(db: Db, workspaceId: string, id: string, data: { at: Date; byFactId: string | null }): Promise<boolean> {
        const r = await db.storyFact.updateMany({ where: { workspaceId, id, supersededAt: null }, data: { supersededAt: data.at, invalidatedByFactId: data.byFactId } });
        return r.count === 1;
    },
    /** The book library's live, confirmed source facts linked to these elements (a resolve's other side). */
    async listConfirmedSourceFactsAbout(db: Db, workspaceId: string, sourceIds: readonly string[], subjectElementIds: readonly string[], take: number): Promise<StoryFactRow[]> {
        if (sourceIds.length === 0 || subjectElementIds.length === 0) return [];
        return sourceFacts(
            await db.storyFact.findMany({
                where: { workspaceId, sourceId: { in: [...sourceIds] }, ...SOURCE_KIND, status: 'CONFIRMED', supersededAt: null, subjectElementId: { in: [...subjectElementIds] } },
                orderBy: [{ statedAt: 'asc' }, { id: 'asc' }],
                take,
                select: FACT_SELECT,
            }),
        );
    },
    /** Serialises a book's fact writes (the bible fact job's resolve and persist, a proposal's decision). */
    async lockBook(db: Db, bookId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'story-facts:' + bookId}))`;
    },
};

export const BookSeriesSourceRepository = {
    async listForBook(db: Db, workspaceId: string, bookId: string, take: number): Promise<string[]> {
        const rows = await db.bookSeriesSource.findMany({ where: { workspaceId, bookId }, orderBy: { createdAt: 'asc' }, take, select: { sourceId: true } });
        return rows.map((r) => r.sourceId);
    },
    async add(db: Db, workspaceId: string, bookId: string, sourceId: string): Promise<void> {
        await db.bookSeriesSource.createMany({ data: [{ workspaceId, bookId, sourceId }], skipDuplicates: true });
    },
    async remove(db: Db, workspaceId: string, bookId: string, sourceId: string): Promise<number> {
        const r = await db.bookSeriesSource.deleteMany({ where: { workspaceId, bookId, sourceId } });
        return r.count;
    },
};

export const StoryFactOverrideRepository = {
    async listForBook(db: Db, workspaceId: string, bookId: string, factIds: readonly string[]): Promise<Array<{ factId: string; text: string; updatedAt: Date }>> {
        if (factIds.length === 0) return [];
        return db.storyFactOverride.findMany({ where: { workspaceId, bookId, factId: { in: [...factIds] } }, take: factIds.length, select: { factId: true, text: true, updatedAt: true } });
    },
    async upsert(db: Db, workspaceId: string, data: { bookId: string; factId: string; text: string; createdById: string }): Promise<{ id: string }> {
        return db.storyFactOverride.upsert({
            where: { workspaceId_bookId_factId: { workspaceId, bookId: data.bookId, factId: data.factId } },
            create: { workspaceId, bookId: data.bookId, factId: data.factId, text: data.text, createdById: data.createdById },
            update: { text: data.text },
            select: { id: true },
        });
    },
    async remove(db: Db, workspaceId: string, bookId: string, factId: string): Promise<number> {
        const r = await db.storyFactOverride.deleteMany({ where: { workspaceId, bookId, factId } });
        return r.count;
    },
};
