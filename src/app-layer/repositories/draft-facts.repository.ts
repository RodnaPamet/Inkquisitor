/**
 * The draft held against the bible (Phase 5.3, D35): the nightly read's runs and per-scene cursors, the draft facts
 * (StoryFact kind SCENE_TEXT), the draft mismatches (StoryFactProposal basis DRAFT) and the thread-to-scene links.
 * Every query filters by `workspaceId` and runs in the caller's `runInWorkspaceContext` transaction, but discovery
 * (`DraftDiscovery`), which reads across workspaces outside row-level security under the closed reason
 * `draft-discovery`, ids only. Every read is bounded.
 *
 * A draft fact's text (subject, statement, quote, object, story time) is encrypted by the extension (the fact columns
 * of the manifest) and sanitised by `sanitiseFactForStorage` before its one insert here; a link's quote likewise by
 * `sanitiseLinkQuoteForStorage`.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { PrismaTx } from '@/lib/db/rls-middleware';

type Db = PrismaTx;

// ─── Discovery (outside RLS, ids only) ────────────────────────────

export interface DueDraftBook {
    workspaceId: string;
    bookId: string;
}

export const DraftDiscovery = {
    /**
     * Live books with a scene whose text was never read (and holds words) or whose revision moved since it was read,
     * not already queued for this night and with no live run; fair-shared between workspaces (each workspace's books
     * least recently read first, taken round by round), bounded by `take`. Ids only.
     */
    async listDueBooks(db: PrismaClient, data: { take: number; staleBefore: Date; nightKey: string; workspaceIds?: readonly string[] }): Promise<DueDraftBook[]> {
        const scope = data.workspaceIds ? Prisma.sql`AND b."workspaceId" = ANY(${[...data.workspaceIds]}::text[])` : Prisma.empty;
        return db.$queryRaw<DueDraftBook[]>(Prisma.sql`
            SELECT "workspaceId", "bookId" FROM (
                SELECT b."workspaceId", b."id" AS "bookId",
                       (SELECT max(r."createdAt") FROM "DraftReadRun" r WHERE r."workspaceId" = b."workspaceId" AND r."bookId" = b."id") AS "lastRunAt",
                       row_number() OVER (PARTITION BY b."workspaceId" ORDER BY
                           (SELECT max(r."createdAt") FROM "DraftReadRun" r WHERE r."workspaceId" = b."workspaceId" AND r."bookId" = b."id") ASC NULLS FIRST, b."id") AS rn
                FROM "Book" b
                WHERE b."deletedAt" IS NULL ${scope}
                  AND EXISTS (SELECT 1 FROM "ManuscriptScene" s
                              LEFT JOIN "SceneDraftRead" d ON d."workspaceId" = s."workspaceId" AND d."bookId" = s."bookId" AND d."sceneId" = s."id"
                              WHERE s."workspaceId" = b."workspaceId" AND s."bookId" = b."id"
                                AND ((d."id" IS NULL AND s."wordCount" > 0) OR (d."id" IS NOT NULL AND d."revision" <> s."revision")))
                  AND NOT EXISTS (SELECT 1 FROM "DraftReadRun" r
                                  WHERE r."workspaceId" = b."workspaceId" AND r."bookId" = b."id"
                                    AND r."status" IN ('QUEUED', 'RUNNING') AND r."createdAt" > ${data.staleBefore})
                  AND NOT EXISTS (SELECT 1 FROM "DraftReadRun" r
                                  WHERE r."workspaceId" = b."workspaceId" AND r."bookId" = b."id" AND r."nightKey" = ${data.nightKey})
            ) due
            ORDER BY rn, "lastRunAt" ASC NULLS FIRST, "workspaceId", "bookId"
            LIMIT ${data.take}`);
    },
};

// ─── Runs ─────────────────────────────────────────────────────────

const RUN_SELECT = {
    id: true,
    bookId: true,
    nightKey: true,
    status: true,
    outcome: true,
    scenesRead: true,
    scenesRemaining: true,
    factsKept: true,
    mismatchesRaised: true,
    mismatchesFixed: true,
    linksProposed: true,
    callsMade: true,
    costMicroUsd: true,
    metrics: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
} as const satisfies Prisma.DraftReadRunSelect;
export type DraftReadRunRow = Prisma.DraftReadRunGetPayload<{ select: typeof RUN_SELECT }>;

export interface DraftRunCounts {
    scenesRead: number;
    scenesRemaining: number;
    factsKept: number;
    mismatchesRaised: number;
    mismatchesFixed: number;
    linksProposed: number;
    callsMade: number;
}

export const DraftReadRunRepository = {
    async create(db: Db, workspaceId: string, bookId: string, nightKey: string): Promise<{ id: string }> {
        return db.draftReadRun.create({ data: { workspaceId, bookId, nightKey }, select: { id: true } });
    },
    async find(db: Db, workspaceId: string, id: string): Promise<DraftReadRunRow | null> {
        return db.draftReadRun.findFirst({ where: { workspaceId, id }, select: RUN_SELECT });
    },
    /** End this book's runs lost by their worker (no sign of life since `staleBefore`): STOPPED CLAIM_EXPIRED, resumable. */
    async expireStale(db: Db, workspaceId: string, bookId: string, staleBefore: Date, at: Date): Promise<number> {
        const r = await db.draftReadRun.updateMany({
            where: { workspaceId, bookId, status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lte: staleBefore } },
            data: { status: 'STOPPED', outcome: 'CLAIM_EXPIRED', finishedAt: at },
        });
        return r.count;
    },
    /** QUEUED → RUNNING, once. */
    async claim(db: Db, workspaceId: string, id: string, at: Date): Promise<boolean> {
        const r = await db.draftReadRun.updateMany({ where: { workspaceId, id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: at } });
        return r.count === 1;
    },
    /** The run's counts and spend so far (a stop later in the night keeps them). */
    async progress(db: Db, workspaceId: string, id: string, counts: DraftRunCounts, costMicroUsd: number): Promise<void> {
        await db.draftReadRun.updateMany({ where: { workspaceId, id, status: 'RUNNING' }, data: { ...counts, costMicroUsd: BigInt(Math.max(0, Math.round(costMicroUsd))) } });
    },
    /** End the run (from QUEUED or RUNNING), once. */
    async finish(
        db: Db,
        workspaceId: string,
        id: string,
        data: { status: string; outcome: string; from: readonly string[]; counts: DraftRunCounts; costMicroUsd: number; promptVersion: string | null; metrics: Prisma.InputJsonValue; at: Date },
    ): Promise<boolean> {
        const r = await db.draftReadRun.updateMany({
            where: { workspaceId, id, status: { in: [...data.from] } },
            data: { status: data.status, outcome: data.outcome, ...data.counts, costMicroUsd: BigInt(Math.max(0, Math.round(data.costMicroUsd))), promptVersion: data.promptVersion, metrics: data.metrics, finishedAt: data.at },
        });
        return r.count === 1;
    },
    /** The book's newest finished run (the Continuity page's "last read"). */
    async lastFinished(db: Db, workspaceId: string, bookId: string): Promise<DraftReadRunRow | null> {
        return db.draftReadRun.findFirst({ where: { workspaceId, bookId, finishedAt: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: RUN_SELECT });
    },
};

// ─── Scene cursors ────────────────────────────────────────────────

export interface DueScene {
    sceneId: string;
    revision: number;
    wordCount: number;
    readTextKey: string | null;
    failures: number;
}

export const SceneDraftReadRepository = {
    /**
     * A book's scenes due a read: never read (and holding words), or read at another revision; least recently read
     * first, then by id. Bounded; one more is asked by the caller to know scenes remain.
     */
    async dueScenes(db: Db, workspaceId: string, bookId: string, take: number): Promise<DueScene[]> {
        const rows = await db.$queryRaw<Array<{ sceneId: string; revision: number; wordCount: number; readTextKey: string | null; failures: number | null }>>(Prisma.sql`
            SELECT s."id" AS "sceneId", s."revision", s."wordCount", d."textKey" AS "readTextKey", d."failures"
            FROM "ManuscriptScene" s
            LEFT JOIN "SceneDraftRead" d ON d."workspaceId" = s."workspaceId" AND d."bookId" = s."bookId" AND d."sceneId" = s."id"
            WHERE s."workspaceId" = ${workspaceId} AND s."bookId" = ${bookId}
              AND ((d."id" IS NULL AND s."wordCount" > 0) OR (d."id" IS NOT NULL AND d."revision" <> s."revision"))
            ORDER BY d."readAt" ASC NULLS FIRST, s."id"
            LIMIT ${take}`);
        return rows.map((r) => ({ ...r, failures: r.failures ?? 0 }));
    },
    /** One scene's stored text and what the read needs of it (decrypted by the extension), or null when it is gone. */
    async sceneForRead(db: Db, workspaceId: string, bookId: string, sceneId: string) {
        return db.manuscriptScene.findFirst({
            where: { workspaceId, bookId, id: sceneId },
            select: { id: true, title: true, text: true, revision: true, storyTime: true, chapter: { select: { title: true } }, beatLinks: { select: { beatElementId: true }, take: 13 } },
        });
    },
    async find(db: Db, workspaceId: string, bookId: string, sceneId: string) {
        return db.sceneDraftRead.findFirst({ where: { workspaceId, bookId, sceneId }, select: { id: true, revision: true, textKey: true, outcome: true, failures: true, readAt: true } });
    },
    /** Write the scene's cursor (the read is done, or the scene passed over). */
    async upsert(db: Db, workspaceId: string, bookId: string, sceneId: string, data: { revision: number; textKey: string; outcome: string; textCut: boolean; failures: number; factsKept: number; costMicroUsd: number; at: Date }) {
        const values = { revision: data.revision, textKey: data.textKey, outcome: data.outcome, textCut: data.textCut, failures: data.failures, factsKept: data.factsKept, costMicroUsd: BigInt(Math.max(0, Math.round(data.costMicroUsd))), readAt: data.at };
        await db.sceneDraftRead.upsert({
            where: { workspaceId_bookId_sceneId: { workspaceId, bookId, sceneId } },
            create: { workspaceId, bookId, sceneId, ...values },
            update: values,
        });
    },
    /** A failure the scene's text causes every night: counted on its cursor (the revision is NOT moved, so it stays due). */
    async countFailure(db: Db, workspaceId: string, bookId: string, sceneId: string, textKey: string, at: Date): Promise<number> {
        const row = await db.sceneDraftRead.findFirst({ where: { workspaceId, bookId, sceneId }, select: { failures: true, textKey: true, revision: true } });
        const failures = row && row.textKey === textKey ? row.failures + 1 : 1;
        await db.sceneDraftRead.upsert({
            where: { workspaceId_bookId_sceneId: { workspaceId, bookId, sceneId } },
            // A first failure leaves the scene due: revision -1 ("never read") matches no scene's revision, which starts at 0.
            create: { workspaceId, bookId, sceneId, revision: -1, textKey, outcome: 'OK', failures, readAt: at },
            update: { failures, textKey },
        });
        return failures;
    },
    /** A book's reading, counted (the Continuity page): scenes with words, read at their revision, waiting, passed over. */
    async progressForBook(db: Db, workspaceId: string, bookId: string): Promise<{ withText: number; read: number; waiting: number; passedOver: number }> {
        const [row] = await db.$queryRaw<Array<{ withText: number; read: number; waiting: number; passedOver: number }>>(Prisma.sql`
            SELECT count(*) FILTER (WHERE s."wordCount" > 0)::int AS "withText",
                   count(*) FILTER (WHERE s."wordCount" > 0 AND d."id" IS NOT NULL AND d."revision" = s."revision" AND d."outcome" IN ('OK', 'GUARD_REFUSED'))::int AS "read",
                   count(*) FILTER (WHERE (d."id" IS NULL AND s."wordCount" > 0) OR (d."id" IS NOT NULL AND d."revision" <> s."revision"))::int AS "waiting",
                   count(*) FILTER (WHERE d."id" IS NOT NULL AND d."revision" = s."revision" AND d."outcome" IN ('CALL_OVER_BUDGET', 'PASSED_OVER'))::int AS "passedOver"
            FROM "ManuscriptScene" s
            LEFT JOIN "SceneDraftRead" d ON d."workspaceId" = s."workspaceId" AND d."bookId" = s."bookId" AND d."sceneId" = s."id"
            WHERE s."workspaceId" = ${workspaceId} AND s."bookId" = ${bookId}`);
        return row ?? { withText: 0, read: 0, waiting: 0, passedOver: 0 };
    },
};

// ─── Draft facts (StoryFact kind SCENE_TEXT) ──────────────────────

const DRAFT_FACT_SELECT = {
    id: true,
    sceneId: true,
    sceneTextKey: true,
    dedupeKey: true,
    subjectName: true,
    subjectElementId: true,
    predicate: true,
    objectLiteral: true,
    statement: true,
    quote: true,
    quoteStart: true,
    quoteEnd: true,
    storyTimeFrom: true,
    storyTimeTo: true,
    supersededAt: true,
    statedAt: true,
} as const satisfies Prisma.StoryFactSelect;
export type DraftFactRow = Prisma.StoryFactGetPayload<{ select: typeof DRAFT_FACT_SELECT }>;

/** One draft fact to write (the text is `sanitiseFactForStorage`'s). */
export type { DraftFactInsert } from './source.repository';

/** Draft facts a scene holds at most (live; the read writes at most `FACTS_PER_CHUNK_MAX` a piece). */
export const DRAFT_FACTS_PER_SCENE_READ_MAX = 2_000;

export const DraftFactRepository = {
    /** A scene's live draft facts, in text order. */
    async liveForScene(db: Db, workspaceId: string, bookId: string, sceneId: string): Promise<DraftFactRow[]> {
        return db.storyFact.findMany({
            where: { workspaceId, bookId, sceneId, sourceKind: 'SCENE_TEXT', supersededAt: null },
            orderBy: [{ quoteStart: 'asc' }, { id: 'asc' }],
            take: DRAFT_FACTS_PER_SCENE_READ_MAX,
            select: DRAFT_FACT_SELECT,
        });
    },
    /** Draft facts by id (live or superseded), any scene of the book. */
    async byIds(db: Db, workspaceId: string, ids: readonly string[]): Promise<DraftFactRow[]> {
        if (ids.length === 0) return [];
        return db.storyFact.findMany({ where: { workspaceId, id: { in: [...ids] }, sourceKind: 'SCENE_TEXT' }, take: ids.length, select: DRAFT_FACT_SELECT });
    },
    /** The live draft facts of these scenes holding these claim keys (a mismatch carried over a re-read is shown where its claim now stands). */
    async liveByKeys(db: Db, workspaceId: string, bookId: string, pairs: ReadonlyArray<{ sceneId: string; dedupeKey: string }>): Promise<DraftFactRow[]> {
        if (pairs.length === 0) return [];
        return db.storyFact.findMany({
            where: { workspaceId, bookId, sourceKind: 'SCENE_TEXT', supersededAt: null, OR: pairs.map((p) => ({ sceneId: p.sceneId, dedupeKey: p.dedupeKey })) },
            take: pairs.length,
            select: DRAFT_FACT_SELECT,
        });
    },
    // The writes (create, supersede, delete) are StoryFactRepository's (`source.repository.ts`): ONE file writes the
    // fact table (the encrypted-field sanitiser guard), so a draft fact is written beside every other kind.
};

// ─── Draft mismatches (StoryFactProposal basis DRAFT) ──────────────

const MISMATCH_SELECT = {
    id: true,
    bookId: true,
    sceneId: true,
    factId: true,
    newerFactId: true,
    kind: true,
    status: true,
    draftClaimKey: true,
    decidedAt: true,
    settledAt: true,
    createdAt: true,
} as const satisfies Prisma.StoryFactProposalSelect;
export type DraftMismatchRow = Prisma.StoryFactProposalGetPayload<{ select: typeof MISMATCH_SELECT }>;

export const DraftMismatchRepository = {
    /** Raise mismatches (the partial unique index holds one open mismatch a bible fact, scene and claim: a repeat is skipped). */
    async raise(db: Db, workspaceId: string, rows: ReadonlyArray<{ bookId: string; sceneId: string; factId: string; newerFactId: string; kind: string; draftClaimKey: string; draftRunId: string }>): Promise<number> {
        if (rows.length === 0) return 0;
        const r = await db.storyFactProposal.createMany({ data: rows.map((x) => ({ workspaceId, ...x, reason: 'CONTRADICTED', basis: 'DRAFT' })), skipDuplicates: true });
        return r.count;
    },
    /** A scene's mismatches of these statuses (bounded). */
    async forScene(db: Db, workspaceId: string, bookId: string, sceneId: string, statuses: readonly string[], take: number): Promise<DraftMismatchRow[]> {
        return db.storyFactProposal.findMany({ where: { workspaceId, bookId, sceneId, basis: 'DRAFT', status: { in: [...statuses] } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: MISMATCH_SELECT });
    },
    /** A book's mismatches of these statuses, newest first (the Continuity page). */
    async forBook(db: Db, workspaceId: string, bookId: string, statuses: readonly string[], take: number): Promise<DraftMismatchRow[]> {
        return db.storyFactProposal.findMany({ where: { workspaceId, bookId, basis: 'DRAFT', status: { in: [...statuses] } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: MISMATCH_SELECT });
    },
    async countForBook(db: Db, workspaceId: string, bookId: string, statuses: readonly string[]): Promise<number> {
        return db.storyFactProposal.count({ where: { workspaceId, bookId, basis: 'DRAFT', status: { in: [...statuses] } } });
    },
    async find(db: Db, workspaceId: string, bookId: string, id: string): Promise<DraftMismatchRow | null> {
        return db.storyFactProposal.findFirst({ where: { workspaceId, bookId, id, basis: 'DRAFT' }, select: MISMATCH_SELECT });
    },
    /** Decide a PENDING mismatch, once (FIX_PENDING, BIBLE_UPDATED or KEPT). */
    async decide(db: Db, workspaceId: string, id: string, data: { status: 'FIX_PENDING' | 'BIBLE_UPDATED' | 'KEPT'; decidedById: string; at: Date }): Promise<boolean> {
        const r = await db.storyFactProposal.updateMany({ where: { workspaceId, id, basis: 'DRAFT', status: 'PENDING' }, data: { status: data.status, decidedById: data.decidedById, decidedAt: data.at } });
        return r.count === 1;
    },
    /**
     * Settle these mismatches FIXED: a re-read no longer finds their claim. A PENDING one is settled with no decider; a
     * FIX_PENDING one keeps its decision (who, when) and gains `settledAt` (the trigger's one second move).
     */
    async settleFixed(db: Db, workspaceId: string, ids: readonly string[], at: Date): Promise<number> {
        if (ids.length === 0) return 0;
        const pending = await db.storyFactProposal.updateMany({ where: { workspaceId, id: { in: [...ids] }, basis: 'DRAFT', status: 'PENDING' }, data: { status: 'FIXED', decidedAt: at, settledAt: at } });
        const fixing = await db.storyFactProposal.updateMany({ where: { workspaceId, id: { in: [...ids] }, basis: 'DRAFT', status: 'FIX_PENDING' }, data: { status: 'FIXED', settledAt: at } });
        return pending.count + fixing.count;
    },
};

// ─── Thread-to-scene links ────────────────────────────────────────

const LINK_SELECT = {
    id: true,
    bookId: true,
    threadId: true,
    sceneId: true,
    role: true,
    quote: true,
    quoteStart: true,
    quoteEnd: true,
    sceneTextKey: true,
    status: true,
    flags: true,
    createdAt: true,
    decidedAt: true,
} as const satisfies Prisma.StoryThreadSceneLinkSelect;
export type ThreadSceneLinkRow = Prisma.StoryThreadSceneLinkGetPayload<{ select: typeof LINK_SELECT }>;

export const ThreadSceneLinkRepository = {
    /** Propose links (one a thread, scene and role, ever: a repeat — rejected or not — is skipped). The quote is `sanitiseLinkQuoteForStorage`'s. */
    async propose(
        db: Db,
        workspaceId: string,
        rows: ReadonlyArray<{ bookId: string; threadId: string; sceneId: string; role: string; quote: string; quoteStart: number; quoteEnd: number; sceneTextKey: string; flags: string[]; runId: string }>,
    ): Promise<number> {
        if (rows.length === 0) return 0;
        const r = await db.storyThreadSceneLink.createMany({ data: rows.map((x) => ({ workspaceId, ...x })), skipDuplicates: true });
        return r.count;
    },
    async find(db: Db, workspaceId: string, bookId: string, id: string): Promise<ThreadSceneLinkRow | null> {
        return db.storyThreadSceneLink.findFirst({ where: { workspaceId, bookId, id }, select: LINK_SELECT });
    },
    async decide(db: Db, workspaceId: string, id: string, data: { status: 'CONFIRMED' | 'REJECTED'; decidedById: string; at: Date }): Promise<boolean> {
        const r = await db.storyThreadSceneLink.updateMany({ where: { workspaceId, id, status: 'PENDING' }, data: { status: data.status, decidedById: data.decidedById, decidedAt: data.at } });
        return r.count === 1;
    },
    /** A book's links of these statuses, newest first (the Continuity page). */
    async forBook(db: Db, workspaceId: string, bookId: string, statuses: readonly string[], take: number): Promise<ThreadSceneLinkRow[]> {
        return db.storyThreadSceneLink.findMany({ where: { workspaceId, bookId, status: { in: [...statuses] } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: LINK_SELECT });
    },
    async countForBook(db: Db, workspaceId: string, bookId: string, statuses: readonly string[]): Promise<number> {
        return db.storyThreadSceneLink.count({ where: { workspaceId, bookId, status: { in: [...statuses] } } });
    },
    /** A scene's links of these statuses (the editor's side panel). */
    async forScene(db: Db, workspaceId: string, bookId: string, sceneId: string, statuses: readonly string[], take: number): Promise<ThreadSceneLinkRow[]> {
        return db.storyThreadSceneLink.findMany({ where: { workspaceId, bookId, sceneId, status: { in: [...statuses] } }, orderBy: [{ quoteStart: 'asc' }, { id: 'asc' }], take, select: LINK_SELECT });
    },
    /** The CONFIRMED links of these threads (the Continuity page's threads; the unpaid-setup signal). */
    async confirmedForThreads(db: Db, workspaceId: string, bookId: string, threadIds: readonly string[], take: number): Promise<ThreadSceneLinkRow[]> {
        if (threadIds.length === 0) return [];
        return db.storyThreadSceneLink.findMany({ where: { workspaceId, bookId, threadId: { in: [...threadIds] }, status: 'CONFIRMED' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: LINK_SELECT });
    },
};

/** Scenes' titles and manuscript positions (part, chapter and scene ranks), for lists and the unpaid-setup order. */
export async function scenesInOrder(db: Db, workspaceId: string, bookId: string, sceneIds: readonly string[]) {
    if (sceneIds.length === 0) return [];
    return db.manuscriptScene.findMany({
        where: { workspaceId, bookId, id: { in: [...sceneIds] } },
        take: sceneIds.length,
        select: { id: true, title: true, rank: true, chapter: { select: { rank: true, title: true, part: { select: { rank: true } } } } },
    });
}
