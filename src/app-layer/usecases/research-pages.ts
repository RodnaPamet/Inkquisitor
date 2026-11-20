/**
 * What the Research page reads (Phase 2.6): the book's briefs with their
 * latest run, and one run's review — its findings with their quoted sources,
 * its proposals beside the current state of what each targets. `bible.view`
 * reads (every member reads the bible and its research); what the viewer may
 * do is the page's `canEdit`, decided on the server.
 *
 * A run reads through `effectiveRunState`: a RUNNING (or QUEUED) run whose
 * worker died reads FAILED `CLAIM_EXPIRED` (2.5's pattern for stale runs), so
 * the page never shows "researching" for ever, and the brief may be run again.
 */
import type { BibleElementKind } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository, BibleFieldRepository, BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import {
    ResearchBriefRepository,
    ResearchFindingRepository,
    ResearchProposalRepository,
    ResearchRunRepository,
    ResearchSourceRepository,
    type ResearchBriefRow,
    type ResearchRunRow,
} from '@/app-layer/repositories/research.repository';
import { ResearchIdParam, SOURCES_PER_BRIEF_MAX } from '@/app-layer/schemas/research';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { NotFoundError } from '@/lib/errors/types';
import { decodeFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { FieldDef } from '@/lib/bible/template-schema';
import { getFieldDef } from '@/lib/bible/templates';
import { decodeResearchValue, decodeSourceUrls } from '@/lib/research/storage';
import type { ProposalStatus } from '@/lib/enrichment/vocabulary';
import { EMPTY_PROGRESS, effectiveRunState, type ResearchOutcome, type ResearchRunStatus, type RunProgress } from '@/lib/research/vocabulary';
import { requireBook } from './bible-common';
import { listElements } from './bible-elements';
import { getBook } from './books';

/** Briefs a page lists at most (it reads one more to say it was cut). */
export const BRIEFS_LISTED_MAX = 50;
const FINDINGS_READ_MAX = 40;
const PROPOSALS_READ_MAX = 80;
const FIELDS_PER_ELEMENT = 50;

export interface RunView {
    id: string;
    briefId: string;
    status: ResearchRunStatus;
    outcome: ResearchOutcome | null;
    depth: string;
    progress: RunProgress;
    spentMicroUsd: number;
    createdAt: string;
    finishedAt: string | null;
    /** Counts and codes only. */
    metrics: {
        searches: number;
        fetches: number;
        sourcesRead: number;
        findingsDrafted: number;
        findingsKept: number;
        proposalsKept: number;
        findingRefusals: Record<string, number>;
        fitRefusals: Record<string, number>;
        reviewRequired: boolean;
        errorCode: string | null;
    };
}

export interface BriefView {
    id: string;
    question: string;
    purpose: string;
    depth: string;
    status: string;
    urls: string[];
    scope: Array<{ id: string; name: string; kind: BibleElementKind }>;
    sources: Array<{ id: string; filename: string; byteLength: number }>;
    createdAt: string;
    latestRun: RunView | null;
}

export interface FindingView {
    id: string;
    ref: string;
    claim: string;
    summary: string;
    confidence: string;
    noFitReason: string | null;
    keptElementId: string | null;
    citations: Array<{ id: string; kind: 'URL' | 'UPLOAD'; url: string | null; title: string | null; quotedSpan: string; retrievedAt: string | null }>;
}

export interface ResearchFieldProposalView {
    id: string;
    kind: 'FIELD';
    status: ProposalStatus;
    operation: 'ADD' | 'UPDATE';
    elementId: string;
    elementName: string;
    elementKind: BibleElementKind;
    fieldKey: string;
    field: FieldDef;
    proposedValue: FieldValue | null;
    currentValue: FieldValue | null;
    baseVersion: number;
    currentVersion: number;
    rationale: string;
    flags: string[];
    findingIds: string[];
}

export interface ResearchNewElementView {
    id: string;
    kind: 'NEW_ELEMENT';
    status: ProposalStatus;
    newKind: BibleElementKind;
    name: string;
    summary: string | null;
    rationale: string;
    flags: string[];
    createdElementId: string | null;
    findingIds: string[];
}

export interface RunReviewView {
    run: RunView;
    findings: FindingView[];
    fields: ResearchFieldProposalView[];
    newElements: ResearchNewElementView[];
}

const asRecord = (v: unknown): Record<string, number> => (v && typeof v === 'object' ? (v as Record<string, number>) : {});

export function runView(run: ResearchRunRow): RunView {
    const state = effectiveRunState(run);
    const m = (run.metrics ?? {}) as Record<string, unknown>;
    const progress = { ...EMPTY_PROGRESS, ...((run.progress ?? {}) as Partial<RunProgress>) };
    const num = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : 0);
    return {
        id: run.id,
        briefId: run.briefId,
        status: state.status,
        outcome: state.outcome,
        depth: run.depth,
        progress: state.status !== run.status ? { ...progress, phase: 'finished' } : progress,
        spentMicroUsd: run.spentMicroUsd,
        createdAt: run.createdAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        metrics: {
            searches: num('searches'),
            fetches: num('fetches'),
            sourcesRead: num('sourcesRead'),
            findingsDrafted: num('findingsDrafted'),
            findingsKept: num('findingsKept'),
            proposalsKept: num('proposalsKept'),
            findingRefusals: asRecord(m.findingRefusals),
            fitRefusals: asRecord(m.fitRefusals),
            reviewRequired: m.reviewRequired === true,
            errorCode: typeof m.errorCode === 'string' ? m.errorCode : null,
        },
    };
}

/** The book's briefs, newest first, each with its latest run and its files (`bible.view`). */
export async function listResearchBriefs(ctx: WorkspaceRequestContext, bookId: string): Promise<{ briefs: BriefView[]; truncated: boolean }> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const rows = await ResearchBriefRepository.list(db, ctx.workspaceId, bookId, BRIEFS_LISTED_MAX + 1);
        const briefs = rows.slice(0, BRIEFS_LISTED_MAX);
        const runs = await ResearchRunRepository.listForBriefs(db, ctx.workspaceId, briefs.map((b) => b.id), briefs.length * 10 + 1);
        const latest = new Map<string, ResearchRunRow>();
        for (const r of runs) if (!latest.has(r.briefId)) latest.set(r.briefId, r);
        const scopeIds = [...new Set(briefs.flatMap((b) => b.scopeElementIds))];
        const elements = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, scopeIds)).map((e) => [e.id, e] as const));
        const out: BriefView[] = [];
        for (const b of briefs) {
            const sources = await ResearchSourceRepository.listForBrief(db, ctx.workspaceId, b.id, SOURCES_PER_BRIEF_MAX);
            out.push(briefView(b, elements, sources, latest.get(b.id) ?? null));
        }
        return { briefs: out, truncated: rows.length > BRIEFS_LISTED_MAX };
    });
}

function briefView(
    b: ResearchBriefRow,
    elements: ReadonlyMap<string, { id: string; name: string; kind: BibleElementKind }>,
    sources: ReadonlyArray<{ id: string; filename: string; byteLength: number }>,
    run: ResearchRunRow | null,
): BriefView {
    const latestRun = run ? runView(run) : null;
    return {
        id: b.id,
        question: b.question,
        purpose: b.purpose,
        depth: b.depth,
        // The brief's status follows its run's, stale runs included.
        status: latestRun ? latestRun.status : b.status,
        urls: decodeSourceUrls(b.sourceUrls),
        scope: b.scopeElementIds.map((id) => elements.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined).map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
        sources: sources.map((s) => ({ id: s.id, filename: s.filename, byteLength: s.byteLength })),
        createdAt: b.createdAt.toISOString(),
        latestRun,
    };
}

/** A run's state alone (the progress stream's read; `bible.view`). */
export async function getResearchRun(ctx: WorkspaceRequestContext, bookId: string, runId: string): Promise<RunView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const run = await ResearchRunRepository.find(db, ctx.workspaceId, ResearchIdParam.parse(runId));
        if (!run || run.bookId !== bookId) throw new NotFoundError('Research run not found.');
        return runView(run);
    });
}

/** One run's review: findings with their sources, proposals beside what they target now (`bible.view`). */
export async function getResearchRunReview(ctx: WorkspaceRequestContext, bookId: string, runId: string): Promise<RunReviewView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const run = await ResearchRunRepository.find(db, ctx.workspaceId, ResearchIdParam.parse(runId));
        if (!run || run.bookId !== bookId) throw new NotFoundError('Research run not found.');
        const findingRows = await ResearchFindingRepository.listForRun(db, ctx.workspaceId, run.id, FINDINGS_READ_MAX);
        const refOf = new Map(findingRows.map((f, i) => [f.id, `f${i + 1}`] as const));
        const findings: FindingView[] = findingRows.map((f) => ({
            id: f.id,
            ref: refOf.get(f.id)!,
            claim: f.claim,
            summary: f.summary,
            confidence: f.confidence,
            noFitReason: f.noFitReason,
            keptElementId: f.keptElementId,
            citations: f.citations.map((c) => ({ id: c.id, kind: c.kind, url: c.url, title: c.title, quotedSpan: c.quotedSpan, retrievedAt: c.retrievedAt ? c.retrievedAt.toISOString() : null })),
        }));
        const proposals = await ResearchProposalRepository.listForRun(db, ctx.workspaceId, run.id, PROPOSALS_READ_MAX);
        const elementIds = [...new Set(proposals.flatMap((p) => (p.elementId ? [p.elementId] : [])))];
        const elements = new Map((await BibleElementRepository.listByIds(db, ctx.workspaceId, bookId, elementIds)).map((e) => [e.id, e] as const));
        const values = new Map<string, Map<string, FieldValue>>();
        for (const f of await BibleFieldRepository.listForElements(db, ctx.workspaceId, [...elements.keys()], FIELDS_PER_ELEMENT)) {
            if (!values.has(f.elementId)) values.set(f.elementId, new Map());
            values.get(f.elementId)!.set(f.key, decodeFieldValue(f.value));
        }
        const versions = new Map<string, number>();
        for (const id of elements.keys()) versions.set(id, await BibleVersionRepository.latestNumber(db, ctx.workspaceId, id));
        const fields: ResearchFieldProposalView[] = [];
        const newElements: ResearchNewElementView[] = [];
        for (const p of proposals) {
            const findingIds = p.findings.map((f) => f.findingId);
            if (p.operation === 'NEW_ELEMENT') {
                newElements.push({ id: p.id, kind: 'NEW_ELEMENT', status: p.status, newKind: p.newKind!, name: p.newName ?? '', summary: p.newSummary, rationale: p.rationale, flags: p.flags, createdElementId: p.createdElementId, findingIds });
                continue;
            }
            const element = elements.get(p.elementId!);
            const def = element ? getFieldDef(element.kind, p.fieldKey!) : undefined;
            if (!element || !def) continue;
            fields.push({
                id: p.id,
                kind: 'FIELD',
                status: p.status,
                operation: p.operation,
                elementId: element.id,
                elementName: element.name,
                elementKind: element.kind,
                fieldKey: def.key,
                field: def,
                proposedValue: decodeResearchValue(p.proposedValue),
                currentValue: values.get(element.id)?.get(def.key) ?? null,
                baseVersion: p.baseVersion!,
                currentVersion: versions.get(element.id) ?? 0,
                rationale: p.rationale,
                flags: p.flags,
                findingIds,
            });
        }
        return { run: runView(run), findings, fields, newElements };
    });
}

/** The scope picker's elements: the first page of the book's elements by name. */
const SCOPE_PICKER_ELEMENTS = 100;

/** Everything the Research page's server component hands its client component (`bible.view`). */
export async function loadResearchPage(ctx: WorkspaceRequestContext, bookId: string) {
    const [book, list, elements] = await Promise.all([getBook(ctx, bookId), listResearchBriefs(ctx, bookId), listElements(ctx, bookId, { take: SCOPE_PICKER_ELEMENTS })]);
    const latest = list.briefs[0]?.latestRun ?? null;
    const initialReview = latest && latest.status !== 'QUEUED' && latest.status !== 'RUNNING' && (latest.metrics.findingsKept > 0 || latest.metrics.proposalsKept > 0) ? await getResearchRunReview(ctx, bookId, latest.id) : null;
    return { book, ...list, elements: elements.elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind })), initialReview };
}
