/**
 * ONE RESEARCH RUN (Phase 2.6, decision D9): the body of the `research-run`
 * job. The worker hands it `{ workspaceId, runId }`; nothing else crosses
 * Redis.
 *
 *   1. CLAIM    read the run in its workspace; anything but QUEUED is left
 *               alone (a duplicate job, a run already ended). The person who
 *               dispatched it is read again from their CURRENT membership: one
 *               who left the workspace or may no longer edit the bible ends the
 *               run REFUSED `REQUESTER_NOT_PERMITTED`, nothing sent. So does a
 *               deployment that can make no model call (`AI_UNAVAILABLE`) or
 *               holds no evaluation record it accepts (`RESEARCH_NOT_EVALUATED`,
 *               D11). Then QUEUED → RUNNING, conditionally (of two workers, one
 *               claims it).
 *   2. READ     the brief, its files, the book's stored text (indexed for the
 *               egress check, never sent), the scope and related elements, and
 *               (Phase 5.1) the scenes of its chapters and its scenes, shown to
 *               the fit step only (`fitScenesOf`). The
 *               brief is checked against the book's text once more: a brief
 *               that now quotes it ends REFUSED `BRIEF_QUOTES_BIBLE`.
 *   3. STEPS    `runResearchSteps` (`src/lib/research/run.ts`), outside every
 *               transaction: gather (the brief alone; every query and URL
 *               through the tripwire), findings, fit. Progress — a phase and
 *               counts, never text — is written to the run as it goes, for the
 *               progress stream.
 *   4. PERSIST  one transaction: every query and fetch URL the gather sent
 *               (D15; each was also written as the stream delivered it), then,
 *               if the run is still RUNNING, every kept
 *               finding with its citations (sanitised again, encrypted), every
 *               proposal that still fits the bible as it stands NOW (an ADD into
 *               a field still empty, an UPDATE of a value still unchanged, a
 *               new element whose name the book still lacks — 2.5's
 *               `bookHoldsElementName`, a scene note whose scene still stands),
 *               each with its findings and the
 *               element's current version as its base; then the run ends with
 *               its outcome, its metrics (counts and codes) and its spend, and
 *               the brief takes the run's status. Audited, counts only.
 *
 * A failed fit call keeps its findings (their own call succeeded) and ends the
 * run with the fit's failure. Nothing here writes the bible: proposals wait
 * for the author (`research-review.ts`). Never throws for a model condition.
 */
import { randomUUID } from 'node:crypto';
import type { BibleElementKind, Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { BibleVersionRepository } from '@/app-layer/repositories/bible.repository';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { WorkspaceRepository } from '@/app-layer/repositories/workspace.repository';
import {
    ResearchBriefRepository,
    ResearchCitationRepository,
    ResearchEgressRepository,
    ResearchFindingRepository,
    ResearchProposalRepository,
    ResearchRunRepository,
    ResearchSourceRepository,
} from '@/app-layer/repositories/research.repository';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { sameFieldValue, type FieldValue } from '@/lib/bible/field-values';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';
import { defaultResearcher } from '@/lib/research/model-seam';
import { researchGate, type ResearchGateVerdict } from '@/lib/research/record-gate';
import type { Researcher } from '@/lib/research/researcher';
import { runResearchSteps, type EgressSeen, type ResearchMetrics, type ResearchStepsResult } from '@/lib/research/run';
import { outgoingTextRefusal } from '@/lib/research/query-egress';
import { decodeSourceUrls, sanitiseEgressForStorage, sanitiseFindingForStorage, sanitiseResearchProposalForStorage } from '@/lib/research/storage';
import { EMPTY_PROGRESS, effectiveRunState, RESEARCH_EGRESS_PER_RUN_MAX, statusOfOutcome, type EgressTool, type ResearchOutcome, type RunProgress } from '@/lib/research/vocabulary';
import { SOURCES_PER_BRIEF_MAX } from '@/app-layer/schemas/research';
import { bookHoldsElementName } from './enrichment-names';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason } from './model-calls';
import { fitScenesOf, readBookText, scopeOf } from './research-common';
import { ManuscriptSceneRepository } from '@/app-layer/repositories/manuscript.repository';

export interface ResearchRunDeps {
    /** The researcher (tests: one over the fake Messages API); omitted: the deployment's. */
    researcher?: (ctx: WorkspaceRequestContext) => Researcher;
    recordMode?: PackRecordMode;
    gate?: () => Promise<ResearchGateVerdict>;
    /** Cancels the run (tests). */
    signal?: AbortSignal;
}

/** The persist transaction's bound: a thorough run stores a few dozen rows. */
const PERSIST_TX_TIMEOUT_MS = 60_000;

/** Progress is written at most this often, and on every phase change. */
const PROGRESS_WRITE_EVERY_MS = 1_000;

function emptyMetrics(extra: Partial<ResearchMetrics> = {}): Partial<ResearchMetrics> {
    return { ...extra };
}

async function finish(
    ctx: { workspaceId: string; requestId: string; userId?: string },
    run: { id: string; briefId: string; bookId: string },
    outcome: ResearchOutcome,
    metrics: Partial<ResearchMetrics> & Record<string, unknown>,
    db?: PrismaTx,
): Promise<void> {
    const write = async (tx: PrismaTx) => {
        const status = statusOfOutcome(outcome);
        const now = new Date();
        const r = await ResearchRunRepository.finish(tx, ctx.workspaceId, run.id, {
            status,
            outcome,
            metrics: metrics as unknown as Prisma.InputJsonValue,
            spentMicroUsd: Math.max(0, Math.round(metrics.costMicroUsd ?? 0)),
            progress: { ...EMPTY_PROGRESS, phase: 'finished', searches: metrics.searches ?? 0, fetches: metrics.fetches ?? 0, sources: metrics.sourcesRead ?? 0, findings: metrics.findingsKept ?? 0, proposals: metrics.proposalsKept ?? 0 } as unknown as Prisma.InputJsonValue,
            finishedAt: now,
        });
        if (r.count === 1) await ResearchBriefRepository.setStatus(tx, ctx.workspaceId, run.briefId, status);
        return r.count === 1;
    };
    const ended = db ? await write(db) : await runInWorkspaceContext(ctx, write);
    if (ended) {
        await logEvent(
            ctx,
            {
                action: 'RESEARCH_RUN_FINISHED',
                entityType: 'ResearchRun',
                entityId: run.id,
                details: {
                    bookId: run.bookId,
                    briefId: run.briefId,
                    outcome,
                    findings: metrics.findingsKept ?? 0,
                    proposals: metrics.proposalsKept ?? 0,
                    searches: metrics.searches ?? 0,
                    fetches: metrics.fetches ?? 0,
                    costMicroUsd: metrics.costMicroUsd ?? 0,
                },
            },
            db ? { db } : {},
        );
    }
}

/** Run one research run (the job's body). Returns whether it ran, and how it ended. */
export async function executeResearchRun(payload: { workspaceId: string; runId: string }, deps: ResearchRunDeps = {}): Promise<{ ran: boolean; outcome: ResearchOutcome | null }> {
    const scope = { workspaceId: payload.workspaceId, requestId: randomUUID() };

    // 1. Claim: the run, the requester's current standing, the deployment.
    const claimed = await runInWorkspaceContext(scope, async (db) => {
        const run = await ResearchRunRepository.find(db, payload.workspaceId, payload.runId);
        if (!run || run.status !== 'QUEUED') return { run: null, ctx: null };
        const slug = await WorkspaceRepository.findSlug(db, payload.workspaceId);
        const membership = run.requestedById ? await MembershipRepository.findForUser(db, payload.workspaceId, run.requestedById) : null;
        if (!slug || !membership || !run.requestedById) return { run, ctx: null };
        const ctx: WorkspaceRequestContext = {
            requestId: scope.requestId,
            userId: run.requestedById,
            workspaceId: payload.workspaceId,
            workspaceSlug: slug,
            role: membership.role,
            permissions: getPermissionsForRole(membership.role),
        };
        return { run, ctx };
    });
    const run = claimed.run;
    if (!run) return { ran: false, outcome: null };
    const ref = { id: run.id, briefId: run.briefId, bookId: run.bookId };
    // A job that waited past the stale bound finds a run the page already reads as
    // FAILED CLAIM_EXPIRED (and the author may have dispatched again): it is ended
    // as it reads, never started late.
    if (effectiveRunState(run).outcome === 'CLAIM_EXPIRED') {
        await finish({ ...scope, userId: claimed.ctx?.userId }, ref, 'CLAIM_EXPIRED', { errorCode: 'CLAIM_EXPIRED' });
        return { ran: true, outcome: 'CLAIM_EXPIRED' };
    }
    const ctx = claimed.ctx;
    if (!ctx || !ctx.permissions.bible.edit) {
        await finish({ ...scope, userId: ctx?.userId }, ref, 'REQUESTER_NOT_PERMITTED', emptyMetrics());
        return { ran: true, outcome: 'REQUESTER_NOT_PERMITTED' };
    }
    const unavailable = modelUnavailableReason();
    if (unavailable) {
        await finish(ctx, ref, 'AI_UNAVAILABLE', { errorCode: unavailable });
        return { ran: true, outcome: 'AI_UNAVAILABLE' };
    }
    const verdict = await (deps.gate ?? (() => researchGate(deps.recordMode ?? deploymentPackRecordMode())))();
    if (!verdict.mounted) {
        await finish(ctx, ref, 'RESEARCH_NOT_EVALUATED', { errorCode: verdict.reason });
        return { ran: true, outcome: 'RESEARCH_NOT_EVALUATED' };
    }

    // 1b + 2. Claim it, and read what the run needs.
    const read = await runInWorkspaceContext(
        ctx,
        async (db) => {
            const won = await ResearchRunRepository.claim(db, ctx.workspaceId, run.id, new Date());
            if (won.count !== 1) return null;
            await ResearchBriefRepository.setStatus(db, ctx.workspaceId, run.briefId, 'RUNNING');
            const brief = await ResearchBriefRepository.find(db, ctx.workspaceId, run.bookId, run.briefId);
            if (!brief) return null;
            const book = await readBookText(db, ctx, run.bookId);
            const uploads = await ResearchSourceRepository.listTextsForBrief(db, ctx.workspaceId, run.briefId, SOURCES_PER_BRIEF_MAX);
            const elements = await scopeOf(db, ctx, run.bookId, brief.scopeElementIds, book);
            const scenes = await fitScenesOf(db, ctx, run.bookId, { chapterIds: brief.scopeChapterIds, sceneIds: brief.scopeSceneIds }, book);
            return { brief, book, uploads, elements, scenes };
        },
        { timeout: 30_000 },
    );
    if (!read) return { ran: false, outcome: null };
    const urls = decodeSourceUrls(read.brief.sourceUrls);
    for (const text of [read.brief.question, read.brief.purpose, ...urls]) {
        if (outgoingTextRefusal(text, read.book.index)) {
            await finish(ctx, ref, 'BRIEF_QUOTES_BIBLE', {});
            return { ran: true, outcome: 'BRIEF_QUOTES_BIBLE' };
        }
    }

    // 3. The steps, outside every transaction; progress as it goes.
    let lastWrite = 0;
    let lastPhase = '';
    let pending: Promise<unknown> = Promise.resolve();
    const observe = (p: RunProgress) => {
        const now = Date.now();
        if (p.phase === lastPhase && now - lastWrite < PROGRESS_WRITE_EVERY_MS) return;
        lastPhase = p.phase;
        lastWrite = now;
        pending = pending
            .then(() => runInWorkspaceContext(ctx, (db) => ResearchRunRepository.setProgress(db, ctx.workspaceId, run.id, p as unknown as Prisma.InputJsonValue)))
            .catch(() => undefined);
    };
    // D15: every query and fetch URL is written as the stream delivers it (each in
    // its own short transaction, one at a time), and the whole list once more
    // before the run ends, whatever ends it — so the result page lists exactly
    // what left, refused ones marked, up to RESEARCH_EGRESS_PER_RUN_MAX.
    const egress: EgressRow[] = [];
    let egressUnlisted = 0;
    let egressPending: Promise<unknown> = Promise.resolve();
    const onEgress = (seen: EgressSeen) => {
        if (egress.length >= RESEARCH_EGRESS_PER_RUN_MAX) {
            egressUnlisted += 1;
            return;
        }
        const row: EgressRow = {
            bookId: run.bookId,
            runId: run.id,
            position: egress.length,
            tool: seen.tool,
            text: sanitiseEgressForStorage(seen.input),
            refusal: seen.refusal === null ? null : REFUSAL_CODE.test(seen.refusal) ? seen.refusal : 'REFUSED',
        };
        egress.push(row);
        egressPending = egressPending
            .then(() => runInWorkspaceContext(ctx, (db) => ResearchEgressRepository.createMany(db, ctx.workspaceId, [row])))
            .catch(() => undefined);
    };
    const flushEgress = async (db?: PrismaTx): Promise<void> => {
        await egressPending;
        if (db) await ResearchEgressRepository.createMany(db, ctx.workspaceId, egress);
        else await runInWorkspaceContext(ctx, (tx) => ResearchEgressRepository.createMany(tx, ctx.workspaceId, egress));
    };
    const egressMetrics = () => ({ egressListed: egress.length, egressUnlisted });
    let result: ResearchStepsResult;
    try {
        result = await runResearchSteps(
            {
                bookId: run.bookId,
                brief: { question: read.brief.question, purpose: read.brief.purpose, urls },
                depth: run.depth,
                uploads: read.uploads.map((u) => ({ sourceId: u.id, filename: u.filename, text: u.text })),
                elements: read.elements,
                bookNames: read.book.names,
                bookIndex: read.book.index,
                scenes: read.scenes.scenes,
            },
            (deps.researcher ?? defaultResearcher)(ctx),
            observe,
            deps.signal,
            onEgress,
        );
    } catch (err) {
        await pending;
        logger.error('research.run_failed', { component: 'research', runId: run.id, errorName: err instanceof Error ? err.name : 'unknown' });
        await flushEgress().catch(() => undefined);
        await finish(ctx, ref, 'INTERNAL', egressMetrics());
        return { ran: true, outcome: 'INTERNAL' };
    }
    await pending;

    // 4. Persist, against the bible as it stands now.
    try {
        const seen = new Map(read.elements.map((e) => [e.elementId, e.stored] as const));
        const metrics = { ...result.metrics, ...egressMetrics(), scenesShown: read.scenes.scenes.length, scenesCut: read.scenes.cut };
        const outcome = await runInWorkspaceContext(
            ctx,
            async (db) => {
                await flushEgress(db);
                return persist(db, ctx, ref, { ...result, metrics }, seen);
            },
            { timeout: PERSIST_TX_TIMEOUT_MS },
        );
        return { ran: true, outcome };
    } catch (err) {
        logger.error('research.persist_failed', { component: 'research', runId: run.id, errorName: err instanceof Error ? err.name : 'unknown' });
        await flushEgress().catch(() => undefined);
        await finish(ctx, ref, 'INTERNAL', { ...result.metrics, ...egressMetrics(), errorCode: 'PERSIST_FAILED' });
        return { ran: true, outcome: 'INTERNAL' };
    }
}

/** A refusal code as the egress row stores it (the CHECK `ResearchEgress_shape`). */
const REFUSAL_CODE = /^[A-Z_]{1,64}$/;

interface EgressRow {
    bookId: string;
    runId: string;
    position: number;
    tool: EgressTool;
    text: string;
    refusal: string | null;
}

async function persist(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    ref: { id: string; briefId: string; bookId: string },
    result: ResearchStepsResult,
    seen: ReadonlyMap<string, ReadonlyMap<string, FieldValue>>,
): Promise<ResearchOutcome> {
    const live = await ResearchRunRepository.find(db, ctx.workspaceId, ref.id);
    if (!live || live.status !== 'RUNNING') return (live?.outcome as ResearchOutcome | null) ?? 'INTERNAL';
    const findingIds = new Map<string, string>();
    for (const [position, f] of result.findings.entries()) {
        const stored = sanitiseFindingForStorage(f, result.noFit.get(f.ref) ?? null);
        const row = await ResearchFindingRepository.create(db, ctx.workspaceId, {
            bookId: ref.bookId,
            runId: ref.id,
            position,
            claim: stored.claim,
            summary: stored.summary,
            confidence: f.confidence,
            noFitReason: stored.noFitReason,
        });
        for (const c of stored.citations) {
            await ResearchCitationRepository.create(db, ctx.workspaceId, { runId: ref.id, findingId: row.id, ...c });
        }
        findingIds.set(f.ref, row.id);
    }
    const book = result.proposals.length > 0 ? await readBookText(db, ctx, ref.bookId) : null;
    let stale = 0;
    let stored = 0;
    for (const p of result.proposals) {
        const findings = p.findingRefs.map((r) => findingIds.get(r)).filter((id): id is string => id !== undefined);
        if (findings.length === 0) continue;
        if (p.operation === 'SCENE_NOTE') {
            // Phase 5.1: a note on a scene still in the book (a deleted scene's note is dropped, counted).
            if (!(await ManuscriptSceneRepository.head(db, ctx.workspaceId, ref.bookId, p.sceneId))) {
                stale += 1;
                continue;
            }
            const text = sanitiseResearchProposalForStorage(p);
            await ResearchProposalRepository.create(db, ctx.workspaceId, {
                bookId: ref.bookId,
                runId: ref.id,
                operation: 'SCENE_NOTE',
                elementId: null,
                fieldKey: null,
                sceneId: p.sceneId,
                proposedValue: text.proposedValue,
                baseVersion: null,
                newKind: null,
                newName: null,
                newSummary: null,
                rationale: text.rationale,
                flags: [...p.flags],
                findingIds: findings,
            });
            stored += 1;
            continue;
        }
        if (p.operation === 'NEW_ELEMENT') {
            if (await bookHoldsElementName(db, ctx, ref.bookId, p.newName)) {
                stale += 1;
                continue;
            }
            const text = sanitiseResearchProposalForStorage(p);
            await ResearchProposalRepository.create(db, ctx.workspaceId, {
                bookId: ref.bookId,
                runId: ref.id,
                operation: 'NEW_ELEMENT',
                elementId: null,
                fieldKey: null,
                proposedValue: null,
                baseVersion: null,
                newKind: p.newKind as BibleElementKind,
                newName: text.newName,
                newSummary: text.newSummary,
                rationale: text.rationale,
                flags: [...p.flags],
                findingIds: findings,
            });
            stored += 1;
            continue;
        }
        // The field must hold what the fit step was shown: still empty for an
        // ADD, the same value for an UPDATE (the author edited it meanwhile:
        // the proposal is dropped, counted, never offered against a value it
        // never saw).
        const element = book!.elements.get(p.elementId);
        const now = element?.stored.get(p.fieldKey) ?? null;
        const then = seen.get(p.elementId)?.get(p.fieldKey) ?? null;
        const fits = element !== undefined && (p.operation === 'ADD' ? now === null : now !== null && sameFieldValue(now, then));
        if (!fits) {
            stale += 1;
            continue;
        }
        const text = sanitiseResearchProposalForStorage(p);
        await ResearchProposalRepository.create(db, ctx.workspaceId, {
            bookId: ref.bookId,
            runId: ref.id,
            operation: p.operation,
            elementId: p.elementId,
            fieldKey: p.fieldKey,
            proposedValue: text.proposedValue,
            baseVersion: Math.max(1, await BibleVersionRepository.latestNumber(db, ctx.workspaceId, p.elementId)),
            newKind: null,
            newName: null,
            newSummary: null,
            rationale: text.rationale,
            flags: [...p.flags],
            findingIds: findings,
        });
        stored += 1;
    }
    const metrics = { ...result.metrics, proposalsKept: stored, proposalsStaleAtSave: stale };
    await finish(ctx, ref, result.outcome, metrics, db);
    return result.outcome;
}
