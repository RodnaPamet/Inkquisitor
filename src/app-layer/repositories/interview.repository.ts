/**
 * The question engine's tables (Phase 2.2): sessions, rounds, questions and
 * answers. Workspace-scoped: every query runs inside `runInWorkspaceContext`
 * (the `workspace_isolation` policy) AND filters by `workspaceId`. No
 * authorization and no validation here: the usecases
 * (`src/app-layer/usecases/interview*.ts`) ask permission, sanitise and
 * validate first.
 *
 * The encrypted columns (a question's text, options, scale labels,
 * recommendation, rationale and challenge quote; an answer's text and
 * choice) are sealed and opened by the field-encryption extension; this
 * module reads and writes plaintext and never filters on them. An Answer is
 * only ever INSERTED (the table is append-only by trigger).
 *
 * Every list is bounded by a `take` its caller chooses.
 */
import type {
    AnswerStatus,
    BibleElementKind,
    InterviewLengthMode,
    InterviewRoundStatus,
    InterviewScope,
    InterviewStatus,
    InterviewStopReason,
    Prisma,
    QuestionGenerator,
    QuestionKind,
    QuestionMode,
    QuestionOrigin,
} from '@prisma/client';
import { PENDING_SUBJECT_ID } from '@/lib/interview/subjects';

type Db = Prisma.TransactionClient;

export const SESSION_SELECT = {
    id: true,
    bookId: true,
    scope: true,
    targetElementId: true,
    targetKind: true,
    scopeElementIds: true,
    scopeRelationIds: true,
    slotKind: true,
    slotAfterElementId: true,
    slotBeforeElementId: true,
    slotAct: true,
    staleFlagId: true,
    stressTestId: true,
    /** Phase 5.3 (SCENE): the scene whose card the session asks about. */
    sceneId: true,
    depth: true,
    detail: true,
    personaKeys: true,
    offerRecommended: true,
    preferChoice: true,
    packPins: true,
    status: true,
    stopReason: true,
    stopDetail: true,
    lengthMode: true,
    roundBudget: true,
    questionBudget: true,
    generatorsOff: true,
    minorAccepted: true,
    roundsRun: true,
    tokenBudget: true,
    tokensUsed: true,
    createdById: true,
    createdAt: true,
    updatedAt: true,
    endedAt: true,
} as const satisfies Prisma.InterviewSessionSelect;

export type SessionRow = Prisma.InterviewSessionGetPayload<{ select: typeof SESSION_SELECT }>;

const ROUND_SELECT = {
    id: true,
    number: true,
    status: true,
    plan: true,
    metrics: true,
    promptVersion: true,
    startedAt: true,
    openedAt: true,
    closedAt: true,
} as const satisfies Prisma.InterviewRoundSelect;

export type RoundRow = Prisma.InterviewRoundGetPayload<{ select: typeof ROUND_SELECT }>;

export const QUESTION_SELECT = {
    id: true,
    roundId: true,
    position: true,
    elementId: true,
    relationId: true,
    aboutPending: true,
    targetsFieldKeys: true,
    mode: true,
    origin: true,
    personaKey: true,
    kind: true,
    text: true,
    options: true,
    scaleLabels: true,
    recommendedAnswer: true,
    recommendationBasis: true,
    rationale: true,
    challengeQuote: true,
    dependsOnQuestionIds: true,
    dedupeKey: true,
    replacesQuestionId: true,
    supersededAt: true,
    reviewRequired: true,
    generator: true,
    angle: true,
    pairElementId: true,
    storyFactId: true,
    continuityRef: true,
    valueScore: true,
    /** Phase 5.3: a question about a scene's card names the scene (it is filed under the scene's carrier element). */
    sceneId: true,
    createdAt: true,
} as const satisfies Prisma.QuestionSelect;

export type QuestionRow = Prisma.QuestionGetPayload<{ select: typeof QUESTION_SELECT }>;

const ANSWER_SELECT = {
    id: true,
    questionId: true,
    revision: true,
    status: true,
    text: true,
    choice: true,
    scale: true,
    acceptedRecommendation: true,
    answeredById: true,
    createdAt: true,
} as const satisfies Prisma.AnswerSelect;

export type AnswerRow = Prisma.AnswerGetPayload<{ select: typeof ANSWER_SELECT }>;

export interface SessionWrite {
    status?: InterviewStatus;
    stopReason?: InterviewStopReason | null;
    stopDetail?: Prisma.InputJsonValue | typeof Prisma.DbNull;
    roundsRun?: number;
    endedAt?: Date | null;
    /** Phase 4.4 (D30): the author chose to go on past the minor questions. */
    minorAccepted?: boolean;
}

export const InterviewSessionRepository = {
    /**
     * Serialise every change to one session: a transaction-scoped advisory
     * lock, held to commit. Claiming a round, answering, closing and stopping
     * queue here, so a round is closed once and claimed once.
     */
    async lock(db: Db, sessionId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'interview-session:' + sessionId}))`;
    },

    /**
     * Phase 4.4 (the hard repetition gate): serialise every write of a book's QUESTIONS — a round's persist and a
     * rephrase — so the check that no question repeats one the book holds and the insert that follows are one step
     * across the book's sessions. Taken AFTER the session's lock, never before it.
     */
    async lockBookQuestions(db: Db, bookId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'interview-book-questions:' + bookId}))`;
    },

    create(
        db: Db,
        workspaceId: string,
        data: {
            bookId: string;
            scope: InterviewScope;
            targetElementId: string | null;
            targetKind: BibleElementKind | null;
            /** Phase 3.3: a SELECTION's elements and relations, frozen at start. */
            scopeElementIds?: string[];
            scopeRelationIds?: string[];
            /** Phase 3.3: a BETWEEN session's slot. */
            slotKind?: BibleElementKind | null;
            slotAfterElementId?: string | null;
            slotBeforeElementId?: string | null;
            slotAct?: string | null;
            /** Phase 4.2: "Grill me on what changed": the stale flag it was started from. */
            staleFlagId?: string | null;
            /** Phase 4.3: the stress test it was started from. */
            stressTestId?: string | null;
            /** Phase 5.3 (SCENE): the scene whose card it asks about. */
            sceneId?: string | null;
            depth: number;
            detail: number;
            personaKeys: string[];
            offerRecommended: boolean;
            preferChoice: boolean;
            /** Phase 4.4 (D23): the session's length; a ROUNDS session's rounds, a QUESTIONS session's questions. */
            lengthMode: InterviewLengthMode;
            roundBudget: number | null;
            questionBudget: number | null;
            /** Phase 4.4 (D30): the generators switched off. */
            generatorsOff: string[];
            tokenBudget: number;
            /** The packs the session mounts, pinned once (Phase 2.3; never updated: a trigger refuses it). */
            packPins: Prisma.InputJsonValue;
            createdById: string;
        },
    ) {
        return db.interviewSession.create({ data: { ...data, workspaceId }, select: SESSION_SELECT });
    },

    find(db: Db, workspaceId: string, bookId: string, sessionId: string) {
        return db.interviewSession.findFirst({ where: { id: sessionId, workspaceId, bookId }, select: SESSION_SELECT });
    },

    /** A book's sessions, newest first (`take` of them). */
    listForBook(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.interviewSession.findMany({
            where: { workspaceId, bookId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            select: SESSION_SELECT,
        });
    },

    async update(db: Db, workspaceId: string, sessionId: string, data: SessionWrite) {
        const res = await db.interviewSession.updateMany({ where: { id: sessionId, workspaceId }, data });
        return res.count;
    },

    /** Charge tokens a round's generation calls reported to the session's budget (`decideStop` reads it). */
    async addTokens(db: Db, workspaceId: string, sessionId: string, tokens: number) {
        if (tokens <= 0) return 0;
        const res = await db.interviewSession.updateMany({ where: { id: sessionId, workspaceId }, data: { tokensUsed: { increment: tokens } } });
        return res.count;
    },
};

export const InterviewRoundRepository = {
    create(db: Db, workspaceId: string, data: { sessionId: string; number: number; plan: Prisma.InputJsonValue; promptVersion: string }) {
        return db.interviewRound.create({ data: { ...data, workspaceId }, select: ROUND_SELECT });
    },

    /**
     * The session's LATEST `take` rounds, by number ascending. Newest first in
     * the query: a session whose rounds keep failing grows past any bound, and
     * the round a request needs (the open or generating one, the next number)
     * is always among the newest, never among the first.
     */
    async listForSession(db: Db, workspaceId: string, sessionId: string, take: number) {
        const rows = await db.interviewRound.findMany({ where: { workspaceId, sessionId }, orderBy: { number: 'desc' }, take, select: ROUND_SELECT });
        return rows.reverse();
    },

    /** One round of the session, by id. */
    find(db: Db, workspaceId: string, sessionId: string, roundId: string) {
        return db.interviewRound.findFirst({ where: { id: roundId, workspaceId, sessionId }, select: ROUND_SELECT });
    },

    /** One round of the session, by number. */
    findByNumber(db: Db, workspaceId: string, sessionId: string, number: number) {
        return db.interviewRound.findFirst({ where: { number, workspaceId, sessionId }, select: ROUND_SELECT });
    },

    async update(
        db: Db,
        workspaceId: string,
        roundId: string,
        data: { status?: InterviewRoundStatus; metrics?: Prisma.InputJsonValue; openedAt?: Date; closedAt?: Date },
    ) {
        const res = await db.interviewRound.updateMany({ where: { id: roundId, workspaceId }, data });
        return res.count;
    },
};

export interface QuestionWrite {
    bookId: string;
    sessionId: string;
    roundId: string;
    position: number;
    elementId: string;
    /** Phase 3.3: the relation it asks about (filed under its declaring element), or none. */
    relationId?: string | null;
    /** Phase 3.3: it asks about the BETWEEN session's element not yet created (filed under the slot's anchor). */
    aboutPending?: boolean;
    targetsFieldKeys: string[];
    mode: QuestionMode;
    origin: QuestionOrigin;
    personaKey: string | null;
    kind: QuestionKind;
    text: string;
    options: string | null;
    scaleLabels: string | null;
    recommendedAnswer: string | null;
    recommendationBasis: Prisma.InputJsonValue | typeof Prisma.DbNull;
    rationale: string | null;
    challengeQuote: string | null;
    dependsOnQuestionIds: string[];
    dedupeKey: string;
    /** The question a rephrase replaces (Phase 2.4); absent for a round's own question. */
    replacesQuestionId?: string | null;
    /** The guard flagged the call that worded it (Phase 2.4). */
    reviewRequired?: boolean;
    /** Phase 4.4 (D30): the generator that proposed it, and what it rests on (ids and codes). */
    generator?: QuestionGenerator;
    angle?: string | null;
    pairElementId?: string | null;
    /** Phase 5.3: a question about a scene's card names the scene. */
    sceneId?: string | null;
    storyFactId?: string | null;
    continuityRef?: string | null;
    valueScore?: number | null;
}

export const QuestionRepository = {
    create(db: Db, workspaceId: string, data: QuestionWrite) {
        return db.question.create({ data: { ...data, workspaceId }, select: QUESTION_SELECT });
    },

    find(db: Db, workspaceId: string, sessionId: string, questionId: string) {
        return db.question.findFirst({ where: { id: questionId, workspaceId, sessionId }, select: QUESTION_SELECT });
    },

    /**
     * Stamp a question replaced by its rephrase (Phase 2.4), once: a question
     * already superseded is left as it is. Answers how many rows it stamped.
     */
    async markSuperseded(db: Db, workspaceId: string, sessionId: string, questionId: string, at: Date): Promise<number> {
        const res = await db.question.updateMany({ where: { id: questionId, workspaceId, sessionId, supersededAt: null }, data: { supersededAt: at } });
        return res.count;
    },

    /** The highest position a round holds (a rephrase is numbered after it), or 0. */
    async maxPosition(db: Db, workspaceId: string, sessionId: string, roundId: string): Promise<number> {
        const row = await db.question.findFirst({ where: { workspaceId, sessionId, roundId }, orderBy: { position: 'desc' }, select: { position: true } });
        return row?.position ?? 0;
    },

    /** A round's questions in their order. */
    listForRound(db: Db, workspaceId: string, sessionId: string, roundId: string, take: number) {
        return db.question.findMany({ where: { workspaceId, sessionId, roundId }, orderBy: { position: 'asc' }, take, select: QUESTION_SELECT });
    },

    /** Every question of a session, oldest first (`take` of them). */
    listForSession(db: Db, workspaceId: string, sessionId: string, take: number) {
        return db.question.findMany({ where: { workspaceId, sessionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: QUESTION_SELECT });
    },

    /**
     * Questions of OTHER sessions of the book about these elements, newest first (`take` of them): book-wide deduplication.
     * Only questions about the elements themselves (Phase 3.3): one filed under an element for its relation or for a
     * BETWEEN session's element not yet created is about something else.
     */
    listForElementsElsewhere(db: Db, workspaceId: string, bookId: string, elementIds: readonly string[], exceptSessionId: string, take: number) {
        if (elementIds.length === 0) return Promise.resolve([]);
        return db.question.findMany({
            where: { workspaceId, bookId, elementId: { in: [...elementIds] }, relationId: null, aboutPending: false, pairElementId: null, sceneId: null, sessionId: { not: exceptSessionId } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            select: QUESTION_SELECT,
        });
    },

    /** Phase 5.3: questions of OTHER sessions of the book about these scenes' cards, newest first (`take` of them): book-wide deduplication. */
    listForScenesElsewhere(db: Db, workspaceId: string, bookId: string, sceneIds: readonly string[], exceptSessionId: string, take: number) {
        if (sceneIds.length === 0) return Promise.resolve([]);
        return db.question.findMany({
            where: { workspaceId, bookId, sceneId: { in: [...sceneIds] }, sessionId: { not: exceptSessionId } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            select: QUESTION_SELECT,
        });
    },

    /** Questions of OTHER sessions of the book about these relations, newest first (`take` of them): book-wide deduplication (Phase 3.3). */
    listForRelationsElsewhere(db: Db, workspaceId: string, bookId: string, relationIds: readonly string[], exceptSessionId: string, take: number) {
        if (relationIds.length === 0) return Promise.resolve([]);
        return db.question.findMany({
            where: { workspaceId, bookId, relationId: { in: [...relationIds] }, sessionId: { not: exceptSessionId } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            select: QUESTION_SELECT,
        });
    },

    /**
     * Which of these (element, dedupe key) pairs a question of the book already
     * holds, each pair once however many questions hold it (no text is read):
     * the exact-repeat lookup beyond the bounded read of earlier questions.
     */
    async findExactRepeats(
        db: Db,
        workspaceId: string,
        bookId: string,
        probes: ReadonlyArray<{ elementId: string; dedupeKey: string; relation?: boolean; pairElementId?: string; pendingIn?: { sessionId: string }; sceneId?: string }>,
    ) {
        if (probes.length === 0) return [];
        // Phase 3.3: a relation's probe names the relation (its subject id); an element's matches only questions about the element itself.
        // Phase 4.4: a pair's probe names its first element and its second (`pairElementId`); it is answered under the pair's subject id.
        // 4.H-a (#66 item 3): a probe for a BETWEEN slot's beat not yet created (`pendingIn`) names the slot's anchor
        // (`elementId`) and the session: it matches that session's earlier questions about the beat, answered under
        // `PENDING_SUBJECT_ID`. Another session's beat after the same anchor is another beat.
        const rows = await db.question.groupBy({
            by: ['elementId', 'relationId', 'pairElementId', 'aboutPending', 'sceneId', 'dedupeKey'],
            where: {
                workspaceId,
                bookId,
                OR: probes.map((p) =>
                    // Phase 5.3: a scene's probe names the scene; its questions are answered under the scene's subject id.
                    p.sceneId
                      ? { sceneId: p.sceneId, dedupeKey: p.dedupeKey }
                      : p.pendingIn
                        ? { aboutPending: true, sessionId: p.pendingIn.sessionId, elementId: p.elementId, dedupeKey: p.dedupeKey }
                        : p.relation
                          ? { aboutPending: false, relationId: p.elementId, dedupeKey: p.dedupeKey }
                          : p.pairElementId
                            ? { aboutPending: false, elementId: p.elementId, pairElementId: p.pairElementId, dedupeKey: p.dedupeKey }
                            : { aboutPending: false, elementId: p.elementId, relationId: null, pairElementId: null, sceneId: null, dedupeKey: p.dedupeKey },
                ),
            },
            orderBy: [{ elementId: 'asc' }, { dedupeKey: 'asc' }],
            take: probes.length * 2,
        });
        return rows.map((r) => ({
            elementId: r.sceneId ? `scene:${r.sceneId}` : r.aboutPending ? PENDING_SUBJECT_ID : (r.relationId ?? (r.pairElementId ? `pair:${r.elementId}:${r.pairElementId}` : r.elementId)),
            dedupeKey: r.dedupeKey,
        }));
    },

    /**
     * Phase 4.4: the book's LADDER and pair questions about these subjects (elements, relations), each with whether an
     * answer to it was ever ANSWERED — what the deepening ladder and the pair questions read to know which layers and
     * angles the book already holds. Codes and ids only; bounded.
     */
    listGeneratorHistory(
        db: Db,
        workspaceId: string,
        bookId: string,
        subjects: { elementIds: readonly string[]; relationIds: readonly string[] },
        take: number,
        /** 4.H-a (#66 item 6): the page after this row (newest first: `createdAt` then `id`, both descending). */
        before?: { createdAt: Date; id: string },
    ) {
        const or: Prisma.QuestionWhereInput[] = [];
        if (subjects.elementIds.length > 0) {
            or.push({ generator: 'LADDER', elementId: { in: [...subjects.elementIds] }, relationId: null, aboutPending: false });
            or.push({ generator: 'RELATIONS', elementId: { in: [...subjects.elementIds] }, pairElementId: { not: null } });
        }
        if (subjects.relationIds.length > 0) or.push({ generator: 'LADDER', relationId: { in: [...subjects.relationIds] } });
        if (or.length === 0) return Promise.resolve([]);
        const page: Prisma.QuestionWhereInput = before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {};
        return db.question.findMany({
            where: { workspaceId, bookId, angle: { not: null }, AND: [{ OR: or }, page] },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
            select: {
                id: true,
                createdAt: true,
                sessionId: true,
                elementId: true,
                relationId: true,
                pairElementId: true,
                targetsFieldKeys: true,
                angle: true,
                generator: true,
                answers: { where: { status: 'ANSWERED' }, select: { id: true }, take: 1 },
            },
        });
    },

    /** The targets of some questions (no encrypted column): what a vector neighbour asked about. */
    targetsOf(db: Db, workspaceId: string, bookId: string, ids: readonly string[]) {
        if (ids.length === 0) return Promise.resolve([]);
        return db.question.findMany({ where: { workspaceId, bookId, id: { in: [...ids] } }, select: { id: true, elementId: true, relationId: true, aboutPending: true, targetsFieldKeys: true }, take: ids.length });
    },

    /** One page of the workspace's questions for a rebuild of their vectors, by id (keyset). */
    pageForEmbedding(db: Db, workspaceId: string, afterId: string | null, take: number) {
        return db.question.findMany({
            where: { workspaceId, ...(afterId ? { id: { gt: afterId } } : {}) },
            orderBy: { id: 'asc' },
            take,
            select: { id: true, bookId: true, text: true },
        });
    },
};

export const AnswerRepository = {
    create(
        db: Db,
        workspaceId: string,
        data: {
            sessionId: string;
            questionId: string;
            revision: number;
            status: AnswerStatus;
            text: string | null;
            choice: string | null;
            scale: number | null;
            acceptedRecommendation: boolean;
            answeredById: string;
        },
    ) {
        return db.answer.create({ data: { ...data, workspaceId }, select: ANSWER_SELECT });
    },

    /** The highest revision a question has, or 0. */
    async latestRevision(db: Db, workspaceId: string, sessionId: string, questionId: string): Promise<number> {
        const row = await db.answer.findFirst({ where: { workspaceId, sessionId, questionId }, orderBy: { revision: 'desc' }, select: { revision: true } });
        return row?.revision ?? 0;
    },

    /** Every answer row of a session (every revision), oldest first (`take` of them). */
    listForSession(db: Db, workspaceId: string, sessionId: string, take: number) {
        return db.answer.findMany({ where: { workspaceId, sessionId }, orderBy: [{ questionId: 'asc' }, { revision: 'asc' }], take, select: ANSWER_SELECT });
    },
};
