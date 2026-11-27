/**
 * The research agent's tables (Phase 2.6): briefs and their attached files,
 * runs, findings and their citations, proposals and the findings they cite.
 * Workspace-scoped: every query runs inside `runInWorkspaceContext` AND
 * filters by `workspaceId`. No authorization and no validation here: the
 * usecases (`src/app-layer/usecases/research-*.ts`) ask permission, validate
 * and sanitise first.
 *
 * The text columns are sealed and opened by the field-encryption extension;
 * this module reads and writes plaintext and never filters on them. A finding,
 * a citation, a proposal and a proposal's finding link are inserted once; a
 * proposal is then only DECIDED (a conditional update from PENDING) and a
 * finding only KEPT (once): triggers refuse any other change.
 *
 * Every list is bounded by a `take` its caller chooses.
 */
import type {
    BibleElementKind,
    EnrichmentProposalStatus,
    Prisma,
    ResearchBriefStatus,
    ResearchConfidence,
    ResearchDepth,
    ResearchProposalOperation,
    ResearchRunStatus,
} from '@prisma/client';

type Db = Prisma.TransactionClient;

const BRIEF_SELECT = {
    id: true,
    bookId: true,
    question: true,
    purpose: true,
    scopeElementIds: true,
    scopeChapterIds: true,
    scopeSceneIds: true,
    sourceUrls: true,
    depth: true,
    status: true,
    requestedById: true,
    createdAt: true,
    updatedAt: true,
} as const satisfies Prisma.ResearchBriefSelect;
export type ResearchBriefRow = Prisma.ResearchBriefGetPayload<{ select: typeof BRIEF_SELECT }>;

const RUN_SELECT = {
    id: true,
    bookId: true,
    briefId: true,
    status: true,
    outcome: true,
    depth: true,
    budget: true,
    spentMicroUsd: true,
    progress: true,
    metrics: true,
    promptVersion: true,
    requestedById: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
} as const satisfies Prisma.ResearchRunSelect;
export type ResearchRunRow = Prisma.ResearchRunGetPayload<{ select: typeof RUN_SELECT }>;

const FINDING_SELECT = {
    id: true,
    runId: true,
    position: true,
    claim: true,
    summary: true,
    confidence: true,
    noFitReason: true,
    keptElementId: true,
    citations: {
        select: { id: true, kind: true, url: true, sourceId: true, title: true, quotedSpan: true, retrievedAt: true },
        orderBy: { id: 'asc' },
        take: 8,
    },
} as const satisfies Prisma.ResearchFindingSelect;
export type ResearchFindingRow = Prisma.ResearchFindingGetPayload<{ select: typeof FINDING_SELECT }>;

export const RESEARCH_PROPOSAL_SELECT = {
    id: true,
    bookId: true,
    runId: true,
    operation: true,
    elementId: true,
    fieldKey: true,
    sceneId: true,
    proposedValue: true,
    baseVersion: true,
    newKind: true,
    newName: true,
    newSummary: true,
    rationale: true,
    flags: true,
    status: true,
    decidedById: true,
    decidedAt: true,
    versionId: true,
    createdElementId: true,
    createdAt: true,
    findings: { select: { findingId: true }, orderBy: { findingId: 'asc' }, take: 20 },
} as const satisfies Prisma.ResearchProposalSelect;
export type ResearchProposalRow = Prisma.ResearchProposalGetPayload<{ select: typeof RESEARCH_PROPOSAL_SELECT }>;

export const ResearchBriefRepository = {
    create(
        db: Db,
        workspaceId: string,
        data: {
            bookId: string;
            question: string;
            purpose: string;
            scopeElementIds: string[];
            scopeChapterIds: string[];
            scopeSceneIds: string[];
            sourceUrls: string | null;
            depth: ResearchDepth;
            requestedById: string;
        },
    ) {
        return db.researchBrief.create({ data: { workspaceId, ...data }, select: BRIEF_SELECT });
    },

    find(db: Db, workspaceId: string, bookId: string, briefId: string) {
        return db.researchBrief.findFirst({ where: { id: briefId, workspaceId, bookId }, select: BRIEF_SELECT });
    },

    /** A book's briefs, newest first. */
    list(db: Db, workspaceId: string, bookId: string, take: number) {
        return db.researchBrief.findMany({ where: { workspaceId, bookId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, select: BRIEF_SELECT });
    },

    setStatus(db: Db, workspaceId: string, briefId: string, status: ResearchBriefStatus) {
        return db.researchBrief.updateMany({ where: { id: briefId, workspaceId }, data: { status } });
    },

    async lock(db: Db, briefId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'research-brief:' + briefId}))`;
    },
};

export const ResearchSourceRepository = {
    create(db: Db, workspaceId: string, data: { bookId: string; briefId: string; filename: string; mediaType: string; byteLength: number; text: string }) {
        return db.researchSource.create({ data: { workspaceId, ...data }, select: { id: true, filename: true, mediaType: true, byteLength: true, createdAt: true } });
    },

    /** A brief's files, without their text (the list). */
    listForBrief(db: Db, workspaceId: string, briefId: string, take: number) {
        return db.researchSource.findMany({
            where: { workspaceId, briefId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take,
            select: { id: true, filename: true, mediaType: true, byteLength: true, createdAt: true },
        });
    },

    /** A brief's files WITH their text (the run reads them). */
    listTextsForBrief(db: Db, workspaceId: string, briefId: string, take: number) {
        return db.researchSource.findMany({ where: { workspaceId, briefId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: { id: true, filename: true, text: true } });
    },

    countForBrief(db: Db, workspaceId: string, briefId: string) {
        return db.researchSource.count({ where: { workspaceId, briefId } });
    },
};

export const ResearchRunRepository = {
    create(db: Db, workspaceId: string, data: { bookId: string; briefId: string; depth: ResearchDepth; budget: Prisma.InputJsonValue; promptVersion: string; requestedById: string; progress: Prisma.InputJsonValue }) {
        return db.researchRun.create({ data: { workspaceId, ...data }, select: RUN_SELECT });
    },

    find(db: Db, workspaceId: string, runId: string) {
        return db.researchRun.findFirst({ where: { id: runId, workspaceId }, select: RUN_SELECT });
    },

    /** A brief's runs, newest first. */
    listForBrief(db: Db, workspaceId: string, briefId: string, take: number) {
        return db.researchRun.findMany({ where: { workspaceId, briefId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, select: RUN_SELECT });
    },

    /** The latest run of each of these briefs (one read: the newest first, the caller keeps the first per brief). */
    listForBriefs(db: Db, workspaceId: string, briefIds: readonly string[], take: number) {
        return db.researchRun.findMany({ where: { workspaceId, briefId: { in: [...briefIds] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, select: RUN_SELECT });
    },

    /** QUEUED → RUNNING, only if still QUEUED: of two workers, one claims it. */
    claim(db: Db, workspaceId: string, runId: string, now: Date) {
        return db.researchRun.updateMany({ where: { id: runId, workspaceId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: now } });
    },

    setProgress(db: Db, workspaceId: string, runId: string, progress: Prisma.InputJsonValue) {
        return db.researchRun.updateMany({ where: { id: runId, workspaceId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { progress } });
    },

    /** End a live run, only if still live. */
    finish(
        db: Db,
        workspaceId: string,
        runId: string,
        data: { status: Exclude<ResearchRunStatus, 'QUEUED' | 'RUNNING'>; outcome: string; metrics: Prisma.InputJsonValue; spentMicroUsd: number; progress: Prisma.InputJsonValue; finishedAt: Date; startedAt?: Date },
    ) {
        return db.researchRun.updateMany({ where: { id: runId, workspaceId, status: { in: ['QUEUED', 'RUNNING'] } }, data });
    },
};

export const ResearchFindingRepository = {
    create(db: Db, workspaceId: string, data: { bookId: string; runId: string; position: number; claim: string; summary: string; confidence: ResearchConfidence; noFitReason: string | null }) {
        return db.researchFinding.create({ data: { workspaceId, ...data }, select: { id: true } });
    },

    listForRun(db: Db, workspaceId: string, runId: string, take: number) {
        return db.researchFinding.findMany({ where: { workspaceId, runId }, orderBy: [{ position: 'asc' }, { id: 'asc' }], take, select: FINDING_SELECT });
    },

    find(db: Db, workspaceId: string, runId: string, findingId: string) {
        return db.researchFinding.findFirst({ where: { id: findingId, workspaceId, runId }, select: FINDING_SELECT });
    },

    /** Record the research note a finding was kept as, once (a trigger refuses any other change). */
    markKept(db: Db, workspaceId: string, findingId: string, keptElementId: string) {
        return db.researchFinding.updateMany({ where: { id: findingId, workspaceId, keptElementId: null }, data: { keptElementId } });
    },
};

export const ResearchCitationRepository = {
    create(
        db: Db,
        workspaceId: string,
        data: { runId: string; findingId: string; kind: 'URL' | 'UPLOAD'; url: string | null; sourceId: string | null; title: string | null; quotedSpan: string; retrievedAt: Date | null; sourceSha256: string | null },
    ) {
        return db.researchCitation.create({ data: { workspaceId, ...data }, select: { id: true } });
    },
};

export const ResearchEgressRepository = {
    /**
     * Record queries and URLs a run sent; a position already written is left
     * as it is (the run writes each as the stream delivers it, then writes the
     * whole list once more before it ends, in case one write was lost).
     */
    createMany(db: Db, workspaceId: string, rows: ReadonlyArray<{ bookId: string; runId: string; position: number; tool: string; text: string; refusal: string | null }>) {
        if (rows.length === 0) return Promise.resolve({ count: 0 });
        return db.researchEgress.createMany({ data: rows.map((r) => ({ workspaceId, ...r })), skipDuplicates: true });
    },

    /** A run's egress in order. */
    listForRun(db: Db, workspaceId: string, runId: string, take: number) {
        return db.researchEgress.findMany({
            where: { workspaceId, runId },
            orderBy: [{ position: 'asc' }],
            take,
            select: { position: true, tool: true, text: true, refusal: true },
        });
    },
};

export interface ResearchProposalWrite {
    bookId: string;
    runId: string;
    operation: ResearchProposalOperation;
    elementId: string | null;
    fieldKey: string | null;
    /** SCENE_NOTE (Phase 5.1): the scene the note is for. */
    sceneId?: string | null;
    proposedValue: string | null;
    baseVersion: number | null;
    newKind: BibleElementKind | null;
    newName: string | null;
    newSummary: string | null;
    rationale: string;
    flags: string[];
    findingIds: string[];
}

export const ResearchProposalRepository = {
    async create(db: Db, workspaceId: string, data: ResearchProposalWrite) {
        const { findingIds, ...row } = data;
        const created = await db.researchProposal.create({ data: { workspaceId, ...row }, select: { id: true } });
        await db.researchProposalFinding.createMany({ data: findingIds.map((findingId) => ({ workspaceId, runId: data.runId, proposalId: created.id, findingId })) });
        return created;
    },

    listForRun(db: Db, workspaceId: string, runId: string, take: number) {
        return db.researchProposal.findMany({ where: { workspaceId, runId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: RESEARCH_PROPOSAL_SELECT });
    },

    find(db: Db, workspaceId: string, proposalId: string) {
        return db.researchProposal.findFirst({ where: { id: proposalId, workspaceId }, select: RESEARCH_PROPOSAL_SELECT });
    },

    /** The pending research proposals for one field, other than `exceptId`. */
    pendingForField(db: Db, workspaceId: string, elementId: string, fieldKey: string, exceptId: string, take: number) {
        return db.researchProposal.findMany({ where: { workspaceId, elementId, fieldKey, status: 'PENDING', id: { not: exceptId } }, take, select: { id: true } });
    },

    /** Decide a PENDING proposal; false when it was already decided. */
    async decide(db: Db, workspaceId: string, proposalId: string, data: { status: EnrichmentProposalStatus; decidedById: string; versionId?: string; createdElementId?: string }): Promise<boolean> {
        const r = await db.researchProposal.updateMany({
            where: { id: proposalId, workspaceId, status: 'PENDING' },
            data: { status: data.status, decidedById: data.decidedById, versionId: data.versionId, createdElementId: data.createdElementId, decidedAt: new Date() },
        });
        return r.count === 1;
    },
};
