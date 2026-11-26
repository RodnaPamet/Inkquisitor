/**
 * Book-level interrogation's tables (Phase 4.3, D29): stress tests and their
 * weak points, gap hunts, interview compactions. Every query filters by
 * workspace (and the RLS policies hold it again); every list is bounded.
 * Author-derived text (a weak point's label and questions, a gap hunt's picks,
 * a compaction's summary) is encrypted by the extension; its writers sanitise
 * first (`encrypted-field-sanitiser-coverage`).
 */
import { Prisma } from '@prisma/client';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import type { StressTestOutcome, StressTestStatus } from '@/lib/stress-test/vocabulary';

type Db = PrismaTx;

const TEST_SELECT = {
    id: true,
    bookId: true,
    status: true,
    outcome: true,
    confirmedWorstMicroUsd: true,
    costMicroUsd: true,
    coverage: true,
    metrics: true,
    promptVersion: true,
    requestedById: true,
    createdAt: true,
    startedAt: true,
    heartbeatAt: true,
    finishedAt: true,
} as const;

export type StressTestRow = Prisma.StressTestGetPayload<{ select: typeof TEST_SELECT }>;

export const StressTestRepository = {
    async create(db: Db, workspaceId: string, data: { bookId: string; confirmedWorstMicroUsd: number; requestedById: string; coverage: Prisma.InputJsonValue }): Promise<{ id: string }> {
        return db.stressTest.create({
            data: { workspaceId, bookId: data.bookId, status: 'QUEUED', confirmedWorstMicroUsd: BigInt(Math.max(0, Math.round(data.confirmedWorstMicroUsd))), requestedById: data.requestedById, coverage: data.coverage },
            select: { id: true },
        });
    },
    async find(db: Db, workspaceId: string, id: string): Promise<StressTestRow | null> {
        return db.stressTest.findFirst({ where: { workspaceId, id }, select: TEST_SELECT });
    },
    async findInBook(db: Db, workspaceId: string, bookId: string, id: string): Promise<StressTestRow | null> {
        return db.stressTest.findFirst({ where: { workspaceId, bookId, id }, select: TEST_SELECT });
    },
    /** A book's newest stress tests. */
    async listForBook(db: Db, workspaceId: string, bookId: string, take: number): Promise<StressTestRow[]> {
        return db.stressTest.findMany({ where: { workspaceId, bookId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, select: TEST_SELECT });
    },
    /** A book's live tests (QUEUED or RUNNING) with a sign of life since `staleBefore`. */
    async liveForBook(db: Db, workspaceId: string, bookId: string, staleBefore: Date): Promise<{ id: string } | null> {
        return db.stressTest.findFirst({ where: { workspaceId, bookId, status: { in: ['QUEUED', 'RUNNING'] }, heartbeatAt: { gt: staleBefore } }, select: { id: true } });
    },
    /** A book's live tests with no sign of life since `staleBefore`: ended STOPPED CLAIM_EXPIRED. */
    async expireStale(db: Db, workspaceId: string, bookId: string, staleBefore: Date, at: Date): Promise<number> {
        const r = await db.stressTest.updateMany({
            where: { workspaceId, bookId, status: { in: ['QUEUED', 'RUNNING'] }, heartbeatAt: { lte: staleBefore } },
            data: { status: 'STOPPED', outcome: 'CLAIM_EXPIRED', finishedAt: at },
        });
        return r.count;
    },
    /** QUEUED → RUNNING, conditionally; the claim's identity is `startedAt`. */
    async claim(db: Db, workspaceId: string, id: string, at: Date): Promise<boolean> {
        const r = await db.stressTest.updateMany({ where: { workspaceId, id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: at, heartbeatAt: at } });
        return r.count === 1;
    },
    async heartbeat(db: Db, workspaceId: string, id: string, claim: Date, at: Date): Promise<void> {
        await db.stressTest.updateMany({ where: { workspaceId, id, status: 'RUNNING', startedAt: claim }, data: { heartbeatAt: at } });
    },
    async finish(
        db: Db,
        workspaceId: string,
        id: string,
        data: { status: Exclude<StressTestStatus, 'QUEUED' | 'RUNNING'>; outcome: StressTestOutcome; from: StressTestStatus[]; claim?: Date; coverage?: Prisma.InputJsonValue; metrics: Prisma.InputJsonValue; promptVersion?: string | null; at: Date },
    ): Promise<boolean> {
        const r = await db.stressTest.updateMany({
            where: { workspaceId, id, status: { in: data.from }, ...(data.claim ? { startedAt: data.claim } : {}) },
            data: {
                status: data.status,
                outcome: data.outcome,
                ...(data.coverage !== undefined ? { coverage: data.coverage } : {}),
                ...(data.promptVersion !== undefined ? { promptVersion: data.promptVersion } : {}),
                metrics: data.metrics,
                finishedAt: data.at,
            },
        });
        return r.count === 1;
    },
    /** What the call cost, counted in its own transaction whatever becomes of the test. */
    async addCost(db: Db, workspaceId: string, id: string, costMicroUsd: number): Promise<void> {
        if (costMicroUsd <= 0) return;
        await db.stressTest.updateMany({ where: { workspaceId, id }, data: { costMicroUsd: { increment: BigInt(Math.round(costMicroUsd)) } } });
    },
};

const WEAK_POINT_SELECT = { id: true, stressTestId: true, position: true, kind: true, title: true, questions: true, citations: true, flags: true } as const;
export type WeakPointRow = Prisma.StressWeakPointGetPayload<{ select: typeof WEAK_POINT_SELECT }>;

export const StressWeakPointRepository = {
    /** The test's weak points, written once (the table is append-only for app_user). */
    async createMany(db: Db, workspaceId: string, stressTestId: string, rows: ReadonlyArray<{ position: number; kind: string; title: string; questions: string; citations: Prisma.InputJsonValue; flags: string[] }>): Promise<number> {
        let n = 0;
        // One insert each: the encryption extension seals each row's columns under the workspace's key.
        for (const r of rows) {
            await db.stressWeakPoint.create({ data: { workspaceId, stressTestId, position: r.position, kind: r.kind, title: r.title, questions: r.questions, citations: r.citations, flags: r.flags }, select: { id: true } });
            n++;
        }
        return n;
    },
    async listForTests(db: Db, workspaceId: string, stressTestIds: readonly string[], take: number): Promise<WeakPointRow[]> {
        if (stressTestIds.length === 0) return [];
        return db.stressWeakPoint.findMany({ where: { workspaceId, stressTestId: { in: [...stressTestIds] } }, orderBy: [{ stressTestId: 'asc' }, { position: 'asc' }], take, select: WEAK_POINT_SELECT });
    },
};

const GAP_SELECT = { id: true, bookId: true, ranked: true, unrankedReason: true, candidates: true, picks: true, bookMark: true, elementsCut: true, costMicroUsd: true, promptVersion: true, refusals: true, createdAt: true } as const;
export type GapHuntRow = Prisma.GapHuntGetPayload<{ select: typeof GAP_SELECT }>;

export const GapHuntRepository = {
    async create(
        db: Db,
        workspaceId: string,
        data: { bookId: string; ranked: boolean; unrankedReason: string | null; candidates: Prisma.InputJsonValue; picks: string; bookMark: number; elementsCut: boolean; costMicroUsd: number; promptVersion: string | null; refusals: Prisma.InputJsonValue; createdById: string },
    ): Promise<{ id: string }> {
        return db.gapHunt.create({
            data: {
                workspaceId,
                bookId: data.bookId,
                ranked: data.ranked,
                unrankedReason: data.unrankedReason,
                candidates: data.candidates,
                picks: data.picks,
                bookMark: data.bookMark,
                elementsCut: data.elementsCut,
                costMicroUsd: BigInt(Math.max(0, Math.round(data.costMicroUsd))),
                promptVersion: data.promptVersion,
                refusals: data.refusals,
                createdById: data.createdById,
            },
            select: { id: true },
        });
    },
    /**
     * RETENTION (D29): a book keeps its newest `keep` gap hunts and no more. Only the newest is read (a hunt is
     * a ranking of the book as it stood, superseded by the next), so older rows are deleted, ids first (bounded).
     */
    async pruneForBook(db: Db, workspaceId: string, bookId: string, keep: number): Promise<number> {
        const old = await db.gapHunt.findMany({ where: { workspaceId, bookId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: keep, take: 100, select: { id: true } });
        if (old.length === 0) return 0;
        return (await db.gapHunt.deleteMany({ where: { workspaceId, id: { in: old.map((r) => r.id) } } })).count;
    },
    async latestForBook(db: Db, workspaceId: string, bookId: string): Promise<GapHuntRow | null> {
        return db.gapHunt.findFirst({ where: { workspaceId, bookId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: GAP_SELECT });
    },
};

const COMPACTION_SELECT = { id: true, sessionId: true, throughRound: true, summary: true, promptVersion: true, createdAt: true } as const;
export type CompactionRow = Prisma.InterviewCompactionGetPayload<{ select: typeof COMPACTION_SELECT }>;

export const InterviewCompactionRepository = {
    /** One summary per (session, through round); a racing second write of the same one is a no-op. */
    async create(db: Db, workspaceId: string, data: { sessionId: string; throughRound: number; summary: string; promptVersion: string; tokensUsed: number; costMicroUsd: number }): Promise<boolean> {
        const r = await db.interviewCompaction.createMany({
            data: [{ workspaceId, sessionId: data.sessionId, throughRound: data.throughRound, summary: data.summary, promptVersion: data.promptVersion, tokensUsed: data.tokensUsed, costMicroUsd: BigInt(Math.max(0, Math.round(data.costMicroUsd))) }],
            skipDuplicates: true,
        });
        return r.count === 1;
    },
    /** The session's summary covering exactly `throughRound`, if any. */
    async findThrough(db: Db, workspaceId: string, sessionId: string, throughRound: number): Promise<CompactionRow | null> {
        return db.interviewCompaction.findFirst({ where: { workspaceId, sessionId, throughRound }, select: COMPACTION_SELECT });
    },
    async listForSession(db: Db, workspaceId: string, sessionId: string, take: number): Promise<CompactionRow[]> {
        return db.interviewCompaction.findMany({ where: { workspaceId, sessionId }, orderBy: [{ throughRound: 'asc' }], take, select: COMPACTION_SELECT });
    },
};

/** What a book's canon holds, counted (a stress test's "left out" is measured against it). */
export async function canonCounts(db: Db, workspaceId: string, bookId: string, sourceIds: readonly string[]): Promise<{ elements: number; facts: number; threads: number; passages: number }> {
    const [elements, facts, threads, passages] = await Promise.all([
        db.bibleElement.count({ where: { workspaceId, bookId } }),
        db.storyFact.count({ where: { workspaceId, supersededAt: null, status: 'CONFIRMED', OR: [{ bookId }, ...(sourceIds.length > 0 ? [{ sourceId: { in: [...sourceIds] } }] : [])] } }),
        db.storyThread.count({ where: { workspaceId, bookId, state: 'OPEN' } }),
        sourceIds.length > 0 ? db.sourceChunk.count({ where: { workspaceId, sourceId: { in: [...sourceIds] } } }) : Promise.resolve(0),
    ]);
    return { elements, facts, threads, passages };
}

/**
 * Which of these cited rows still stand, as `TYPE:id` (a stress test checks again at persist): the book's elements
 * and open-or-closed threads, live facts, and chunks of the sources the book draws on.
 */
export async function existingRefs(db: Db, workspaceId: string, bookId: string, refs: ReadonlyArray<{ type: string; id: string }>, sourceIds: readonly string[]): Promise<Set<string>> {
    const ids = (type: string) => [...new Set(refs.filter((r) => r.type === type).map((r) => r.id))];
    const out = new Set<string>();
    const elements = ids('ELEMENT');
    const facts = ids('FACT');
    const threads = ids('THREAD');
    const passages = ids('PASSAGE');
    if (elements.length > 0) for (const r of await db.bibleElement.findMany({ where: { workspaceId, bookId, id: { in: elements } }, take: elements.length, select: { id: true } })) out.add(`ELEMENT:${r.id}`);
    if (facts.length > 0) for (const r of await db.storyFact.findMany({ where: { workspaceId, id: { in: facts }, supersededAt: null }, take: facts.length, select: { id: true } })) out.add(`FACT:${r.id}`);
    if (threads.length > 0) for (const r of await db.storyThread.findMany({ where: { workspaceId, bookId, id: { in: threads } }, take: threads.length, select: { id: true } })) out.add(`THREAD:${r.id}`);
    if (passages.length > 0 && sourceIds.length > 0) {
        for (const r of await db.sourceChunk.findMany({ where: { workspaceId, id: { in: passages }, sourceId: { in: [...sourceIds] } }, take: passages.length, select: { id: true } })) out.add(`PASSAGE:${r.id}`);
    }
    return out;
}

/** A book's bible versions, counted (element and relation versions): a gap hunt's "the book changed since" mark. */
export async function bookVersionMark(db: Db, workspaceId: string, bookId: string): Promise<number> {
    const [elements, relations] = await Promise.all([db.bibleEntryVersion.count({ where: { workspaceId, bookId } }), db.bibleRelationVersion.count({ where: { workspaceId, bookId } })]);
    return elements + relations;
}

/**
 * Per kind: relations with an element of the kind at one end, live facts about the kind's elements, and other
 * elements whose accepted versions cite answers about the kind's elements (a gap hunt's signals).
 */
export async function gapSignals(db: Db, workspaceId: string, bookId: string): Promise<Array<{ kind: string; relations: number; facts: number; citations: number }>> {
    return db.$queryRaw<Array<{ kind: string; relations: number; facts: number; citations: number }>>`
        SELECT k.kind::text AS kind,
            (SELECT count(*)::int FROM "BibleRelation" r JOIN "BibleElement" e ON e.id IN (r."fromElementId", r."toElementId")
                WHERE r."workspaceId" = ${workspaceId} AND r."bookId" = ${bookId} AND e.kind = k.kind) AS relations,
            (SELECT count(*)::int FROM "StoryFact" f JOIN "BibleElement" e ON e.id = f."subjectElementId"
                WHERE f."workspaceId" = ${workspaceId} AND f."bookId" = ${bookId} AND f."supersededAt" IS NULL AND e.kind = k.kind) AS facts,
            (SELECT count(DISTINCT v."elementId")::int FROM "BibleEntryVersion" v
                JOIN "Answer" a ON a.id = ANY (v."sourceAnswerIds")
                JOIN "Question" q ON q.id = a."questionId"
                JOIN "BibleElement" e ON e.id = q."elementId"
                WHERE v."workspaceId" = ${workspaceId} AND v."bookId" = ${bookId} AND v."elementId" <> q."elementId" AND e.kind = k.kind) AS citations
        FROM (SELECT DISTINCT kind FROM "BibleElement" WHERE "workspaceId" = ${workspaceId} AND "bookId" = ${bookId}) k`;
}

/** Facts' subject elements, by fact id (a stress test's session scope). */
export async function factSubjects(db: Db, workspaceId: string, factIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (factIds.length === 0) return out;
    for (const f of await db.storyFact.findMany({ where: { workspaceId, id: { in: [...factIds] } }, take: factIds.length, select: { id: true, subjectElementId: true } })) {
        if (f.subjectElementId) out.set(f.id, f.subjectElementId);
    }
    return out;
}

/** What a page shows for cited facts, threads and passages (decrypted by the extension), by id. */
export async function citedRows(
    db: Db,
    workspaceId: string,
    bookId: string,
    ids: { facts: readonly string[]; threads: readonly string[]; passages: readonly string[] },
): Promise<{ facts: Array<{ id: string; subjectName: string; statement: string }>; threads: Array<{ id: string; title: string }>; passages: Array<{ id: string; headingPath: string | null }> }> {
    const [facts, threads, passages] = await Promise.all([
        ids.facts.length > 0 ? db.storyFact.findMany({ where: { workspaceId, id: { in: [...ids.facts] } }, take: ids.facts.length, select: { id: true, subjectName: true, statement: true } }) : Promise.resolve([]),
        ids.threads.length > 0 ? db.storyThread.findMany({ where: { workspaceId, bookId, id: { in: [...ids.threads] } }, take: ids.threads.length, select: { id: true, title: true } }) : Promise.resolve([]),
        ids.passages.length > 0 ? db.sourceChunk.findMany({ where: { workspaceId, id: { in: [...ids.passages] } }, take: ids.passages.length, select: { id: true, headingPath: true } }) : Promise.resolve([]),
    ]);
    return { facts, threads, passages };
}

/** Facts' subjects and predicates, by fact id (what an interview from a stress test challenges first). */
export async function factSubjectsAndPredicates(db: Db, workspaceId: string, factIds: readonly string[]): Promise<Array<{ id: string; subjectElementId: string | null; predicate: string }>> {
    if (factIds.length === 0) return [];
    return db.storyFact.findMany({ where: { workspaceId, id: { in: [...factIds] } }, take: factIds.length, select: { id: true, subjectElementId: true, predicate: true } });
}
