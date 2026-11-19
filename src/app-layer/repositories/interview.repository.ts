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
import type { AnswerStatus, BibleElementKind, InterviewRoundStatus, InterviewScope, InterviewStatus, InterviewStopReason, Prisma, QuestionKind, QuestionMode, QuestionOrigin } from '@prisma/client';

type Db = Prisma.TransactionClient;

export const SESSION_SELECT = {
    id: true,
    bookId: true,
    scope: true,
    targetElementId: true,
    targetKind: true,
    depth: true,
    detail: true,
    personaKeys: true,
    offerRecommended: true,
    preferChoice: true,
    status: true,
    stopReason: true,
    stopDetail: true,
    roundBudget: true,
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

    create(
        db: Db,
        workspaceId: string,
        data: {
            bookId: string;
            scope: InterviewScope;
            targetElementId: string | null;
            targetKind: BibleElementKind | null;
            depth: number;
            detail: number;
            personaKeys: string[];
            offerRecommended: boolean;
            preferChoice: boolean;
            roundBudget: number;
            tokenBudget: number;
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
}

export const QuestionRepository = {
    create(db: Db, workspaceId: string, data: QuestionWrite) {
        return db.question.create({ data: { ...data, workspaceId }, select: QUESTION_SELECT });
    },

    find(db: Db, workspaceId: string, sessionId: string, questionId: string) {
        return db.question.findFirst({ where: { id: questionId, workspaceId, sessionId }, select: QUESTION_SELECT });
    },

    /** A round's questions in their order. */
    listForRound(db: Db, workspaceId: string, sessionId: string, roundId: string, take: number) {
        return db.question.findMany({ where: { workspaceId, sessionId, roundId }, orderBy: { position: 'asc' }, take, select: QUESTION_SELECT });
    },

    /** Every question of a session, oldest first (`take` of them). */
    listForSession(db: Db, workspaceId: string, sessionId: string, take: number) {
        return db.question.findMany({ where: { workspaceId, sessionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: QUESTION_SELECT });
    },

    /** Questions of OTHER sessions of the book about these elements, newest first (`take` of them): book-wide deduplication. */
    listForElementsElsewhere(db: Db, workspaceId: string, bookId: string, elementIds: readonly string[], exceptSessionId: string, take: number) {
        if (elementIds.length === 0) return Promise.resolve([]);
        return db.question.findMany({
            where: { workspaceId, bookId, elementId: { in: [...elementIds] }, sessionId: { not: exceptSessionId } },
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
    async findExactRepeats(db: Db, workspaceId: string, bookId: string, probes: ReadonlyArray<{ elementId: string; dedupeKey: string }>) {
        if (probes.length === 0) return [];
        const rows = await db.question.groupBy({
            by: ['elementId', 'dedupeKey'],
            where: { workspaceId, bookId, OR: probes.map((p) => ({ elementId: p.elementId, dedupeKey: p.dedupeKey })) },
        });
        return rows.map((r) => ({ elementId: r.elementId, dedupeKey: r.dedupeKey }));
    },

    /** The targets of some questions (no encrypted column): what a vector neighbour asked about. */
    targetsOf(db: Db, workspaceId: string, bookId: string, ids: readonly string[]) {
        if (ids.length === 0) return Promise.resolve([]);
        return db.question.findMany({ where: { workspaceId, bookId, id: { in: [...ids] } }, select: { id: true, elementId: true, targetsFieldKeys: true }, take: ids.length });
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
