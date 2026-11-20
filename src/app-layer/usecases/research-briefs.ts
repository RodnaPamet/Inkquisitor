/**
 * Research briefs (Phase 2.6, decision D9): write one, attach files to it, and
 * dispatch a run of it.
 *
 *   create     `bible.edit`. The question, the purpose and the URLs are
 *              author-private text: bounded, sanitised, encrypted. Each scope
 *              element must be in the book (`SCOPE_ELEMENT_NOT_IN_BOOK`), each
 *              URL an http(s) address (`URL_INVALID`), and NONE of the brief's
 *              text may quote the book's stored text (`BRIEF_QUOTES_BIBLE`,
 *              422, naming the part): queries are written from the brief, so a
 *              brief that carried bible text would carry it out (D9).
 *   attach     `bible.edit`. A file through the 1.3 import path: the body read
 *              bounded (`SOURCE_UPLOAD_MAX_BYTES`, 413 past it), virus-scanned
 *              (`assertUploadClean`: INFECTED always refused, an unavailable
 *              scan refused in `strict`), plain text or Markdown only, decoded
 *              as UTF-8 (a file that is not is refused), sanitised and stored
 *              as encrypted text — never as a file.
 *   dispatch   `bible.edit`; a missing brief or deleted book is a 404 first. Refused before anything is written when no model
 *              call can be made (503 AI_UNAVAILABLE) or the research prompts
 *              have no evaluation record this deployment accepts (503
 *              RESEARCH_NOT_EVALUATED, D11); refused 409 RUN_IN_PROGRESS while
 *              the brief has a live run (a stale one, which reads FAILED
 *              CLAIM_EXPIRED, is ended in the database first, so its job can
 *              no longer claim or save it); and the brief is checked against the
 *              book's text again (the bible may have moved since it was
 *              written). Then one QUEUED run, committed, and one BullMQ job
 *              naming it by id (`research-run`, payload `{ workspaceId, runId }`,
 *              job id `research-run-<runId>`).
 *
 * Nothing here writes the bible, and nothing calls a model.
 */
import type { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { enqueue } from '@/app-layer/jobs/queue';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { ResearchBriefRepository, ResearchRunRepository, ResearchSourceRepository, type ResearchRunRow } from '@/app-layer/repositories/research.repository';
import { CreateBriefInput, ResearchIdParam, SOURCES_PER_BRIEF_MAX } from '@/app-layer/schemas/research';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { AppError, ConflictError, ServiceUnavailableError, ValidationError } from '@/lib/errors/types';
import { AiUnavailableError } from '@/lib/ai/errors';
import { logger } from '@/lib/observability/logger';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { RESEARCH_PROMPT_VERSION } from '@/lib/research/prompt';
import { researchGate, type ResearchGateVerdict } from '@/lib/research/record-gate';
import { decodeSourceUrls, ResearchTextNotStorableError, sanitiseBriefForStorage, sanitiseSourceForStorage } from '@/lib/research/storage';
import { webUrlOf } from '@/lib/research/sources';
import { DEPTH_BUDGETS, EMPTY_PROGRESS, effectiveRunState } from '@/lib/research/vocabulary';
import { assertUploadClean } from './bible-import';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason } from './model-calls';
import { assertBriefLeavesNoBookText, readBookText, requireBrief } from './research-common';
import { requireBook } from './bible-common';

export interface ResearchDispatchDeps {
    /** Which evaluation records count (D11); omitted: the deployment's. */
    recordMode?: PackRecordMode;
    /** The gate's verdict (tests). */
    gate?: () => Promise<ResearchGateVerdict>;
    /** The enqueue (tests: a queue of their own, or a spy). */
    enqueue?: (payload: { workspaceId: string; runId: string }, jobId: string) => Promise<unknown>;
    /** The virus scanner (tests). */
    scan?: Parameters<typeof assertUploadClean>[2]['scan'];
}

/** The media types a research file may be. */
export const SOURCE_MEDIA_TYPES = ['text/plain', 'text/markdown'] as const;

/** Write a brief (`bible.edit`; the rules in the header). */
export async function createResearchBrief(ctx: WorkspaceRequestContext, bookId: string, input: unknown) {
    await assertPermission(ctx, 'bible.edit');
    const parsed = CreateBriefInput.parse(input);
    const urls: string[] = [];
    for (const raw of parsed.urls) {
        const url = webUrlOf(raw);
        if (!url) throw new ValidationError('A source URL must be an http or https address.', { reason: 'URL_INVALID' });
        if (!urls.includes(url)) urls.push(url);
    }
    let text: ReturnType<typeof sanitiseBriefForStorage>;
    try {
        text = sanitiseBriefForStorage({ question: parsed.question, purpose: parsed.purpose, urls });
    } catch (err) {
        // A question or purpose that sanitises to nothing (blank, or markup alone) is the author's to fix: a 400, never a 500.
        if (err instanceof ResearchTextNotStorableError) throw new ValidationError('Write the question and what it is for in words.', { reason: 'BRIEF_EMPTY', part: err.what });
        throw err;
    }
    const scopeIds = [...new Set(parsed.scopeElementIds)];
    return runInWorkspaceContext(
        ctx,
        async (db) => {
            await requireBook(db, ctx, bookId);
            const book = await readBookText(db, ctx, bookId);
            for (const id of scopeIds) {
                if (!book.elements.has(id)) throw new ValidationError('A scope element is not in this book.', { reason: 'SCOPE_ELEMENT_NOT_IN_BOOK' });
            }
            assertBriefLeavesNoBookText({ question: text.question, purpose: text.purpose, urls: decodeSourceUrls(text.sourceUrls) }, book.index);
            const brief = await ResearchBriefRepository.create(db, ctx.workspaceId, {
                bookId,
                question: text.question,
                purpose: text.purpose,
                scopeElementIds: scopeIds,
                sourceUrls: text.sourceUrls,
                depth: parsed.depth,
                requestedById: ctx.userId,
            });
            await logEvent(
                ctx,
                { action: 'RESEARCH_BRIEF_CREATED', entityType: 'ResearchBrief', entityId: brief.id, details: { bookId, depth: parsed.depth, scopeCount: scopeIds.length, urlCount: urls.length } },
                { db },
            );
            return { id: brief.id };
        },
        { timeout: 30_000 },
    );
}

/** Attach a text file to a brief (`bible.edit`; the 1.3 path: bounded by the route, scanned here). */
export async function attachResearchSource(
    ctx: WorkspaceRequestContext,
    bookId: string,
    briefId: string,
    upload: { bytes: Uint8Array; mediaType: string; filename: string },
    deps: ResearchDispatchDeps = {},
) {
    await assertPermission(ctx, 'bible.edit');
    const id = ResearchIdParam.parse(briefId);
    const mediaType = upload.mediaType.split(';')[0].trim().toLowerCase();
    if (!(SOURCE_MEDIA_TYPES as readonly string[]).includes(mediaType)) throw new ValidationError('Attach a plain-text or Markdown file.', { reason: 'SOURCE_TYPE' });
    // A missing brief (or a deleted book) is a 404 before the file is scanned; checked again under the lock below.
    await runInWorkspaceContext(ctx, (db) => requireBrief(db, ctx, bookId, id));
    await assertUploadClean(ctx, upload.bytes, { scan: deps.scan }, 'research-source');
    let decoded: string;
    try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(upload.bytes);
    } catch {
        throw new ValidationError('The file is not UTF-8 text.', { reason: 'SOURCE_NOT_TEXT' });
    }
    if (decoded.trim() === '') throw new ValidationError('The file is empty.', { reason: 'SOURCE_EMPTY' });
    let stored: { filename: string; text: string };
    try {
        stored = sanitiseSourceForStorage({ filename: upload.filename || 'source.txt', text: decoded });
    } catch {
        throw new ValidationError('The file holds no text.', { reason: 'SOURCE_EMPTY' });
    }
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBrief(db, ctx, bookId, id);
        await ResearchBriefRepository.lock(db, id);
        if ((await ResearchSourceRepository.countForBrief(db, ctx.workspaceId, id)) >= SOURCES_PER_BRIEF_MAX) {
            throw new ConflictError('This brief holds as many files as it can.', { reason: 'SOURCES_FULL' });
        }
        const row = await ResearchSourceRepository.create(db, ctx.workspaceId, { bookId, briefId: id, filename: stored.filename, mediaType, byteLength: upload.bytes.byteLength, text: stored.text });
        await logEvent(ctx, { action: 'RESEARCH_SOURCE_ATTACHED', entityType: 'ResearchSource', entityId: row.id, details: { bookId, briefId: id, byteLength: upload.bytes.byteLength, mediaType } }, { db });
        return { id: row.id, filename: row.filename, byteLength: row.byteLength };
    });
}

function isLive(run: ResearchRunRow): boolean {
    const state = effectiveRunState(run);
    return state.status === 'QUEUED' || state.status === 'RUNNING';
}

/** Dispatch a run of a brief (`bible.edit`; the rules in the header). */
export async function dispatchResearchRun(ctx: WorkspaceRequestContext, bookId: string, briefId: string, deps: ResearchDispatchDeps = {}): Promise<{ runId: string }> {
    await assertPermission(ctx, 'bible.edit');
    const id = ResearchIdParam.parse(briefId);
    // A missing brief (or a deleted book) is a 404 before anything about the deployment is said.
    await runInWorkspaceContext(ctx, (db) => requireBrief(db, ctx, bookId, id));
    const unavailable = modelUnavailableReason();
    if (unavailable) throw new AiUnavailableError(unavailable);
    const verdict = await (deps.gate ?? (() => researchGate(deps.recordMode ?? deploymentPackRecordMode())))();
    if (!verdict.mounted) {
        throw new ServiceUnavailableError('Research is not available in this deployment yet.', { reason: 'RESEARCH_NOT_EVALUATED', gate: verdict.reason });
    }
    const run = await runInWorkspaceContext(
        ctx,
        async (db) => {
            const brief = await requireBrief(db, ctx, bookId, id);
            await ResearchBriefRepository.lock(db, id);
            const latest = (await ResearchRunRepository.listForBrief(db, ctx.workspaceId, id, 1))[0];
            if (latest && isLive(latest)) throw new ConflictError('This brief is already being researched.', { reason: 'RUN_IN_PROGRESS', runId: latest.id });
            if (latest && (latest.status === 'QUEUED' || latest.status === 'RUNNING')) {
                // A stale claim (it reads FAILED CLAIM_EXPIRED) is ended in the database before
                // another run starts, so its job, if it is still queued or still running, can
                // neither claim it nor save over it: two runs of one brief never spend at once.
                const now = new Date();
                await ResearchRunRepository.finish(db, ctx.workspaceId, latest.id, {
                    status: 'FAILED',
                    outcome: 'CLAIM_EXPIRED',
                    metrics: { ...((latest.metrics ?? {}) as Record<string, unknown>), errorCode: 'CLAIM_EXPIRED' } as Prisma.InputJsonValue,
                    spentMicroUsd: Number(latest.spentMicroUsd),
                    progress: { ...EMPTY_PROGRESS, ...((latest.progress ?? {}) as Record<string, unknown>), phase: 'finished' } as Prisma.InputJsonValue,
                    finishedAt: now,
                    ...(latest.startedAt ? {} : { startedAt: now }),
                });
            }
            const book = await readBookText(db, ctx, bookId);
            assertBriefLeavesNoBookText({ question: brief.question, purpose: brief.purpose, urls: decodeSourceUrls(brief.sourceUrls) }, book.index);
            const created = await ResearchRunRepository.create(db, ctx.workspaceId, {
                bookId,
                briefId: id,
                depth: brief.depth,
                budget: { ...DEPTH_BUDGETS[brief.depth] } as unknown as Prisma.InputJsonValue,
                promptVersion: RESEARCH_PROMPT_VERSION,
                requestedById: ctx.userId,
                progress: { ...EMPTY_PROGRESS } as unknown as Prisma.InputJsonValue,
            });
            await ResearchBriefRepository.setStatus(db, ctx.workspaceId, id, 'QUEUED');
            await logEvent(ctx, { action: 'RESEARCH_RUN_DISPATCHED', entityType: 'ResearchRun', entityId: created.id, details: { bookId, briefId: id, depth: brief.depth } }, { db });
            return created;
        },
        { timeout: 30_000 },
    );
    const payload = { workspaceId: ctx.workspaceId, runId: run.id };
    const jobId = `research-run-${run.id}`;
    try {
        await (deps.enqueue ?? ((p, j) => enqueue('research-run', p, { jobId: j })))(payload, jobId);
    } catch (err) {
        // The job never reached the queue: the run is ended at once, never left QUEUED for ever.
        logger.error('research.enqueue_failed', { component: 'research', runId: run.id, error: err instanceof AppError ? err.code : 'unknown' });
        await runInWorkspaceContext(ctx, async (db) => {
            const now = new Date();
            await ResearchRunRepository.finish(db, ctx.workspaceId, run.id, {
                status: 'FAILED',
                outcome: 'INTERNAL',
                metrics: { errorCode: 'ENQUEUE_FAILED' },
                spentMicroUsd: 0,
                progress: { ...EMPTY_PROGRESS, phase: 'finished' },
                finishedAt: now,
                startedAt: now,
            });
            await ResearchBriefRepository.setStatus(db, ctx.workspaceId, id, 'FAILED');
        });
        throw err;
    }
    return { runId: run.id };
}
