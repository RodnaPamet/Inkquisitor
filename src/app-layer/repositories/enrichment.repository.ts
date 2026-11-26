/**
 * Enrichment's tables (Phase 2.5): reconcile runs, proposals and their
 * citations, and the reads of a session's answers a review shows beside them.
 * Workspace-scoped: every query runs inside `runInWorkspaceContext` (the
 * `workspace_isolation` policy) AND filters by `workspaceId`. No
 * authorization and no validation here: the usecases
 * (`src/app-layer/usecases/enrichment-*.ts`) ask permission, validate and
 * sanitise first.
 *
 * A proposal's value, and a new element's name and summary, are sealed and
 * opened by the field-encryption extension; this module reads and writes
 * plaintext and never filters on them. A proposal is inserted once and then
 * only DECIDED (`decide`, a conditional update from PENDING: the trigger
 * `enrichment_proposal_fixed` refuses any other change); a citation is only
 * inserted.
 *
 * Every list is bounded by a `take` its caller chooses.
 */
import type { BibleElementKind, EnrichmentOperation, EnrichmentProposalKind, EnrichmentProposalStatus, Prisma, ReconcileRunStatus } from '@prisma/client';

type Db = Prisma.TransactionClient;

const RUN_SELECT = {
    id: true,
    sessionId: true,
    roundId: true,
    status: true,
    outcome: true,
    metrics: true,
    promptVersion: true,
    attempts: true,
    startedAt: true,
    finishedAt: true,
} as const satisfies Prisma.ReconcileRunSelect;

export type ReconcileRunRow = Prisma.ReconcileRunGetPayload<{ select: typeof RUN_SELECT }>;

export const PROPOSAL_SELECT = {
    id: true,
    bookId: true,
    sessionId: true,
    roundId: true,
    kind: true,
    elementId: true,
    relationId: true,
    fieldKey: true,
    operation: true,
    proposedValue: true,
    baseVersion: true,
    newKind: true,
    newName: true,
    newSummary: true,
    fillsSlot: true,
    newRelationType: true,
    newFromElementId: true,
    newToElementId: true,
    newFromProposalId: true,
    newToProposalId: true,
    targetProposalId: true,
    createdRelationId: true,
    flags: true,
    status: true,
    decidedById: true,
    decidedAt: true,
    versionId: true,
    createdElementId: true,
    createdAt: true,
    citations: { select: { answerId: true }, orderBy: { answerId: 'asc' }, take: 50 },
} as const satisfies Prisma.EnrichmentProposalSelect;

export type ProposalRow = Prisma.EnrichmentProposalGetPayload<{ select: typeof PROPOSAL_SELECT }>;

export interface ProposalWrite {
    bookId: string;
    sessionId: string;
    roundId: string;
    kind: EnrichmentProposalKind;
    elementId: string | null;
    fieldKey: string | null;
    operation: EnrichmentOperation | null;
    proposedValue: string | null;
    baseVersion: number | null;
    newKind: BibleElementKind | null;
    newName: string | null;
    newSummary: string | null;
    /** The author's warnings (D14), from `PROPOSAL_FLAGS`. */
    flags: string[];
    /** Phase 3.3 (D24): a RELATION_FIELD's relation; a NEW_ELEMENT that fills a BETWEEN slot; a NEW_RELATION's type and ends. */
    relationId?: string | null;
    fillsSlot?: boolean;
    newRelationType?: string | null;
    newFromElementId?: string | null;
    newToElementId?: string | null;
    newFromProposalId?: string | null;
    newToProposalId?: string | null;
    /** Phase 3.H (D25 as amended): a FIELD proposal for the slot's beat not yet created, by its NEW_ELEMENT proposal. */
    targetProposalId?: string | null;
}

export const ReconcileRunRepository = {
    find(db: Db, workspaceId: string, sessionId: string, roundId: string) {
        return db.reconcileRun.findFirst({ where: { workspaceId, sessionId, roundId }, select: RUN_SELECT });
    },

    /** A session's runs (`take` of them, newest round first). */
    listForSession(db: Db, workspaceId: string, sessionId: string, take: number) {
        return db.reconcileRun.findMany({ where: { workspaceId, sessionId }, orderBy: { startedAt: 'desc' }, take, select: RUN_SELECT });
    },

    create(db: Db, workspaceId: string, data: { bookId: string; sessionId: string; roundId: string; promptVersion: string }) {
        return db.reconcileRun.create({ data: { ...data, workspaceId, status: 'RUNNING' }, select: RUN_SELECT });
    },

    /** Claim a FAILED or REFUSED (or stale RUNNING) run again: RUNNING, one more attempt. */
    async reclaim(db: Db, workspaceId: string, runId: string, promptVersion: string, attempts: number) {
        await db.reconcileRun.updateMany({
            where: { id: runId, workspaceId },
            data: { status: 'RUNNING', outcome: null, finishedAt: null, metrics: undefined, promptVersion, attempts, startedAt: new Date() },
        });
    },

    /** End a run: its status, outcome and counts. Only from RUNNING under this claim's attempt, so a stale claim never overwrites a newer one. */
    async finish(db: Db, workspaceId: string, runId: string, attempt: number, data: { status: Exclude<ReconcileRunStatus, 'RUNNING'>; outcome: string; metrics: Prisma.InputJsonValue }): Promise<boolean> {
        const res = await db.reconcileRun.updateMany({
            where: { id: runId, workspaceId, status: 'RUNNING', attempts: attempt },
            data: { ...data, finishedAt: new Date() },
        });
        return res.count === 1;
    },
};

export const EnrichmentProposalRepository = {
    /** Insert a proposal and its citations (the deferred trigger refuses one with none at commit). */
    async create(db: Db, workspaceId: string, data: ProposalWrite, citedAnswerIds: readonly string[]) {
        const row = await db.enrichmentProposal.create({ data: { ...data, workspaceId }, select: { id: true } });
        await db.enrichmentCitation.createMany({ data: citedAnswerIds.map((answerId) => ({ workspaceId, sessionId: data.sessionId, proposalId: row.id, answerId })) });
        return row;
    },

    find(db: Db, workspaceId: string, sessionId: string, proposalId: string) {
        return db.enrichmentProposal.findFirst({ where: { id: proposalId, workspaceId, sessionId }, select: PROPOSAL_SELECT });
    },

    /** Some proposals of a session by id. */
    listByIds(db: Db, workspaceId: string, sessionId: string, ids: readonly string[]) {
        if (ids.length === 0) return Promise.resolve([]);
        return db.enrichmentProposal.findMany({ where: { workspaceId, sessionId, id: { in: [...ids] } }, orderBy: { createdAt: 'asc' }, take: ids.length, select: PROPOSAL_SELECT });
    },

    /** A session's proposals, oldest first (`take` of them; ask one more to know the list was cut). */
    listForSession(db: Db, workspaceId: string, sessionId: string, take: number) {
        return db.enrichmentProposal.findMany({ where: { workspaceId, sessionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: PROPOSAL_SELECT });
    },

    /** The book's PENDING proposals counted per session (the board's "to review"; nothing decrypted). */
    async pendingBySession(db: Db, workspaceId: string, bookId: string, take: number): Promise<Array<{ sessionId: string; pending: number }>> {
        const rows = await db.enrichmentProposal.groupBy({
            by: ['sessionId'],
            where: { workspaceId, bookId, status: 'PENDING' },
            _count: { _all: true },
            orderBy: { sessionId: 'asc' },
            take,
        });
        return rows.map((r) => ({ sessionId: r.sessionId, pending: r._count._all }));
    },

    /** The names of the book's PENDING new-element proposals (decrypted: compared in code). */
    /**
     * The session's proposals of a beat for its BETWEEN slot that still hold it
     * (Phase 3.H, issue #53 item 1): one PENDING, or accepted with the element
     * it created. At most a few a session; `take` bounds it.
     */
    slotHolders(db: Db, workspaceId: string, sessionId: string, take: number) {
        return db.enrichmentProposal.findMany({
            where: { workspaceId, sessionId, kind: 'NEW_ELEMENT', fillsSlot: true, status: { in: ['PENDING', 'ACCEPTED', 'EDITED_ACCEPTED'] } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take,
            select: { id: true, status: true, createdElementId: true, newName: true, proposedValue: true },
        });
    },

    pendingNewElementNames(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.enrichmentProposal.findMany({
            where: { workspaceId, bookId, status: 'PENDING', kind: 'NEW_ELEMENT' },
            orderBy: { createdAt: 'asc' },
            take,
            select: { newName: true },
        });
    },

    /** The other PENDING proposals for one field of a slot's beat, named by the beat's proposal (Phase 3.H). */
    pendingForSlotBeatField(db: Db, workspaceId: string, targetProposalId: string, fieldKey: string, exceptId: string, take: number) {
        return db.enrichmentProposal.findMany({
            where: { workspaceId, targetProposalId, fieldKey, status: 'PENDING', id: { not: exceptId } },
            orderBy: { createdAt: 'asc' },
            take,
            select: { id: true },
        });
    },

    /** The other PENDING proposals for one field (superseded by an acceptance). */
    pendingForField(db: Db, workspaceId: string, elementId: string, fieldKey: string, exceptId: string, take: number) {
        return db.enrichmentProposal.findMany({
            where: { workspaceId, elementId, fieldKey, status: 'PENDING', id: { not: exceptId } },
            orderBy: { createdAt: 'asc' },
            take,
            select: { id: true, sessionId: true },
        });
    },

    /** The other PENDING proposals for one relation field (Phase 3.3; superseded by an acceptance). */
    pendingForRelationField(db: Db, workspaceId: string, relationId: string, fieldKey: string, exceptId: string, take: number) {
        return db.enrichmentProposal.findMany({
            where: { workspaceId, relationId, fieldKey, status: 'PENDING', id: { not: exceptId } },
            orderBy: { createdAt: 'asc' },
            take,
            select: { id: true, sessionId: true },
        });
    },

    /**
     * The book's PENDING structural proposals (Phase 3.3: new elements and new
     * relations), oldest first, decrypted, with their citations: what a story
     * map previews as ghosts and lists beside them. `take` bounds it.
     */
    pendingStructuralForBook(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.enrichmentProposal.findMany({
            where: { workspaceId, bookId, status: 'PENDING', kind: { in: ['NEW_ELEMENT', 'NEW_RELATION'] } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take,
            select: PROPOSAL_SELECT,
        });
    },

    /** The NEW_ELEMENT proposals a NEW_RELATION's ends name (Phase 3.3), by id, in a session. */
    listEnds(db: Db, workspaceId: string, sessionId: string, ids: readonly string[]) {
        if (ids.length === 0) return Promise.resolve([]);
        return db.enrichmentProposal.findMany({
            where: { workspaceId, sessionId, id: { in: [...ids] }, kind: 'NEW_ELEMENT' },
            take: ids.length,
            select: { id: true, status: true, createdElementId: true, newKind: true, newName: true },
        });
    },

    /**
     * Decide a PENDING proposal, once: a conditional update, so of two
     * concurrent decisions exactly one lands (the count says which).
     */
    async decide(
        db: Db,
        workspaceId: string,
        proposalId: string,
        data: { status: Exclude<EnrichmentProposalStatus, 'PENDING'>; decidedById: string; versionId?: string | null; createdElementId?: string | null; createdRelationId?: string | null },
    ): Promise<boolean> {
        const res = await db.enrichmentProposal.updateMany({
            where: { id: proposalId, workspaceId, status: 'PENDING' },
            data: {
                status: data.status,
                decidedById: data.decidedById,
                decidedAt: new Date(),
                versionId: data.versionId ?? null,
                createdElementId: data.createdElementId ?? null,
                createdRelationId: data.createdRelationId ?? null,
            },
        });
        return res.count === 1;
    },
};

/** The answers a review shows beside its proposals: each with the question it answers (decrypted). */
export const EnrichmentAnswerReads = {
    listCited(db: Db, workspaceId: string, sessionId: string, answerIds: readonly string[]) {
        if (answerIds.length === 0) return Promise.resolve([]);
        return db.answer.findMany({
            where: { workspaceId, sessionId, id: { in: [...answerIds] } },
            orderBy: { createdAt: 'asc' },
            take: answerIds.length,
            select: {
                id: true,
                questionId: true,
                status: true,
                text: true,
                choice: true,
                scale: true,
                question: { select: { id: true, text: true, kind: true, elementId: true, targetsFieldKeys: true, roundId: true, personaKey: true } },
            },
        });
    },
};
