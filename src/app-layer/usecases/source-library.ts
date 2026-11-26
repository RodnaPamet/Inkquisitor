/**
 * THE SOURCE LIBRARY (Phase 4.0, decisions D23 and D26): upload, list,
 * remove, a book's series opt-ins, and starting (or resuming) an ingestion
 * once the author has seen and confirmed its cost.
 *
 *   upload    `bible.edit`; a book's library (a missing or deleted book is a
 *             404 first) or the workspace's series library. The 1.3 path: the
 *             body read bounded by the route (`SOURCE_UPLOAD_MAX_BYTES`, 413),
 *             virus-scanned (`assertUploadClean`: INFECTED always refused, an
 *             unavailable scan refused in `strict`), the format SNIFFED from
 *             the bytes and parsed (`src/lib/sources/parse.ts`, every refusal
 *             a named reason), cut into chunks along chapters and scenes,
 *             each sanitised and stored encrypted — never the file. The cost of
 *             extracting its facts is computed and stored (`cost.ts`); nothing
 *             is sent to a model here. In ONE transaction under the library's
 *             lock: at most `SOURCES_PER_LIBRARY_MAX` sources (409
 *             LIBRARY_FULL), the same content twice refused (409
 *             SOURCE_DUPLICATE; a unique index under concurrency), and a
 *             CHANGED file under a name the library holds is a new version
 *             superseding the newest one of that name.
 *   ingest    `bible.edit`. Refused before anything is written when no model
 *             call can be made (503 AI_UNAVAILABLE) or the extraction prompt
 *             has no evaluation record this deployment accepts (503
 *             SOURCE_FACTS_NOT_EVALUATED, D11); 409 INGEST_IN_PROGRESS while it
 *             runs; 409 NOTHING_TO_INGEST when every chunk is done. The author
 *             names the "at most" they saw (`confirmWorstCaseMicroUsd`): when
 *             the remaining chunks' worst case is more, 409 ESTIMATE_CHANGED
 *             with the figures, nothing queued — so a job never spends more than
 *             the amount the author confirmed (its BUDGET). Then QUEUED, and one
 *             `source-ingest` job naming it by id.
 *   remove    `bible.edit`; its chunks, facts, vectors and opt-ins go with it.
 *   opt in    `bible.edit`; a series source only.
 *
 * `bible.view` reads every list. Nothing here writes the bible.
 */
import { createHmac } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { enqueue } from '@/app-layer/jobs/queue';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { BibleElementRepository } from '@/app-layer/repositories/bible.repository';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import {
    BookSeriesSourceRepository,
    SourceChunkRepository,
    SourceLibraryRepository,
    SourceRepository,
    StoryFactRepository,
    type SourceLibraryRow,
    type SourceRow,
} from '@/app-layer/repositories/source.repository';
import { AiUnavailableError } from '@/lib/ai/errors';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { AppError, ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '@/lib/errors/types';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { logger } from '@/lib/observability/logger';
import { workspaceSubkey } from '@/lib/security/encryption';
import { chunkBlocks } from '@/lib/sources/chunk';
import { chunkCost, sourceCost } from '@/lib/sources/cost';
import { blocksText } from '@/lib/sources/document';
import { parseSource, SourceRefusal, type ParseDeps } from '@/lib/sources/parse';
import { EXTRACT_PROMPT_VERSION } from '@/lib/sources/prompt';
import { extractionGate, type ExtractionGateVerdict } from '@/lib/sources/record-gate';
import { decodeHeadingPath, sanitiseChunkForStorage, sanitiseSourceNameForStorage, SourceTextNotStorableError } from '@/lib/sources/storage';
import { awaitsEmbedding, CHUNKS_PER_SOURCE_MAX, effectiveSourceState, isLiveStatus, SOURCES_PER_LIBRARY_MAX, type SourceFormat, type SourceStatus } from '@/lib/sources/vocabulary';
import { assertUploadClean } from './bible-import';
import { requireBook } from './bible-common';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason } from './model-calls';
import { LIBRARY_READ_MAX, requireSource } from './source-common';

export type SourceTarget = { kind: 'book'; bookId: string } | { kind: 'series' };

export interface SourceLibraryDeps extends ParseDeps {
    scan?: Parameters<typeof assertUploadClean>[2]['scan'];
    recordMode?: PackRecordMode;
    gate?: () => ExtractionGateVerdict;
    enqueue?: (payload: { workspaceId: string; sourceId: string }, jobId: string) => Promise<unknown>;
}

/** A source as the pages show it: counts, codes and amounts (µUSD as numbers), its name. */
export interface SourceView {
    id: string;
    filename: string;
    format: SourceFormat;
    byteLength: number;
    version: number;
    supersedesId: string | null;
    status: SourceStatus;
    outcome: string | null;
    chunkCount: number;
    chunksDone: number;
    factCount: number;
    estimateMicroUsd: number;
    worstCaseMicroUsd: number;
    spentMicroUsd: number;
    scope: 'BOOK' | 'SERIES';
    createdAt: string;
    finishedAt: string | null;
    /** 4.H-a (#60 item 6): every passage read, the embedding failed — a resume re-embeds (and costs no model call). */
    awaitsEmbedding: boolean;
}

/** The book's element names an extraction is shown (and links subjects by), bounded. */
export const BOOK_NAMES_MAX = 200;
/** Chunks written per statement. */
const CHUNK_INSERT_BATCH = 200;

export function sourceView(row: SourceRow, now: Date = new Date()): SourceView {
    const state = effectiveSourceState(row, now);
    return {
        id: row.id,
        filename: row.filename,
        format: row.format,
        byteLength: row.byteLength,
        version: row.version,
        supersedesId: row.supersedesId,
        status: state.status,
        outcome: state.outcome,
        chunkCount: row.chunkCount,
        chunksDone: row.chunksDone,
        factCount: row.factCount,
        estimateMicroUsd: Number(row.estimateMicroUsd),
        worstCaseMicroUsd: Number(row.worstCaseMicroUsd),
        spentMicroUsd: Number(row.spentMicroUsd),
        scope: row.library.scope,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        awaitsEmbedding: awaitsEmbedding({ status: state.status, outcome: state.outcome, metrics: row.metrics }),
    };
}

/** The book's element names, bounded (the extraction's `book-names` block and its subject links). */
export async function bookNamesOf(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<Array<{ id: string; name: string; kind: string }>> {
    const rows = await BibleElementRepository.listForInterview(db, ctx.workspaceId, bookId, { take: BOOK_NAMES_MAX });
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind }));
}

function contentHashOf(workspaceId: string, text: string): string {
    return createHmac('sha256', workspaceSubkey('inkquisitor-source-content/1', workspaceId)).update(text, 'utf8').digest('hex');
}

async function ensureLibrary(db: PrismaTx, ctx: WorkspaceRequestContext, target: SourceTarget): Promise<SourceLibraryRow> {
    await SourceLibraryRepository.lock(db, target.kind === 'book' ? `${ctx.workspaceId}:book:${target.bookId}` : `${ctx.workspaceId}:series`);
    const found = target.kind === 'book' ? await SourceLibraryRepository.findForBook(db, ctx.workspaceId, target.bookId) : await SourceLibraryRepository.findSeries(db, ctx.workspaceId);
    return found ?? SourceLibraryRepository.create(db, ctx.workspaceId, { scope: target.kind === 'book' ? 'BOOK' : 'SERIES', bookId: target.kind === 'book' ? target.bookId : null });
}

function refusalOf(err: SourceRefusal): AppError {
    const details = { reason: err.reason, ...(err.detail ? { detail: err.detail } : {}) };
    return new ValidationError('The file could not be read as a source.', details);
}

/** Upload a source (`bible.edit`; the rules in the header). */
export async function uploadSource(ctx: WorkspaceRequestContext, target: SourceTarget, upload: { bytes: Uint8Array; filename: string }, deps: SourceLibraryDeps = {}): Promise<SourceView> {
    await assertPermission(ctx, 'bible.edit');
    // A missing or deleted book is a 404 before the file is scanned or read.
    if (target.kind === 'book') await runInWorkspaceContext(ctx, (db) => requireBook(db, ctx, target.bookId));
    await assertUploadClean(ctx, upload.bytes, { scan: deps.scan }, 'source');
    let parsed: Awaited<ReturnType<typeof parseSource>>;
    try {
        parsed = await parseSource(upload.bytes, upload.filename, deps);
    } catch (err) {
        if (err instanceof SourceRefusal) throw refusalOf(err);
        throw err;
    }
    const drafts = chunkBlocks(parsed.blocks);
    if (drafts.length > CHUNKS_PER_SOURCE_MAX) throw new ValidationError('The file is too long to read as one source.', { reason: 'SOURCE_TOO_LONG' });
    const chunks: Array<{ position: number; headingPath: string | null; text: string; startOffset: number; endOffset: number; tokenEstimate: number }> = [];
    for (const d of drafts) {
        try {
            const stored = sanitiseChunkForStorage({ text: d.text, headingPath: d.headingPath });
            chunks.push({ position: chunks.length, headingPath: stored.headingPath, text: stored.text, startOffset: d.startOffset, endOffset: d.endOffset, tokenEstimate: Math.ceil(stored.text.length / 4) });
        } catch (err) {
            // A chunk of nothing but markup holds no words: it is not a passage.
            if (!(err instanceof SourceTextNotStorableError)) throw err;
        }
    }
    if (chunks.length === 0) throw new ValidationError('The file holds no text.', { reason: 'SOURCE_EMPTY' });
    const filename = sanitiseSourceNameForStorage(upload.filename || 'source');
    const contentHash = contentHashOf(ctx.workspaceId, blocksText(parsed.blocks));

    const created = await runInWorkspaceContext(
        ctx,
        async (db) => {
            // 4.H-a (#57 item 4): the book is checked again IN THIS transaction, its row held to commit, so a book deleted
            // while the file was scanned and parsed never gains a library or a source.
            if (target.kind === 'book' && !(await BookRepository.findLiveForShare(db, ctx.workspaceId, target.bookId))) throw new NotFoundError('Book not found.');
            const bookNames = target.kind === 'book' ? (await bookNamesOf(db, ctx, target.bookId)).map((n) => n.name) : [];
            const cost = sourceCost(chunks.map((c) => ({ headings: decodeHeadingPath(c.headingPath), text: c.text, bookNames })));
            const library = await ensureLibrary(db, ctx, target);
            const existing = await SourceRepository.listForLibrary(db, ctx.workspaceId, library.id, LIBRARY_READ_MAX);
            if (existing.length >= SOURCES_PER_LIBRARY_MAX) throw new ConflictError('This library holds as many files as it can.', { reason: 'LIBRARY_FULL' });
            const duplicate = await SourceRepository.findByContent(db, ctx.workspaceId, library.id, contentHash);
            if (duplicate) throw new ConflictError('This library already holds that text.', { reason: 'SOURCE_DUPLICATE', sourceId: duplicate.id });
            // A changed file under a name the library holds: the next version of the newest source of that name.
            const previous = existing.find((s) => s.filename === filename) ?? null;
            const row = await SourceRepository.create(db, ctx.workspaceId, {
                libraryId: library.id,
                filename,
                format: parsed.format,
                byteLength: upload.bytes.byteLength,
                contentHash,
                version: previous ? previous.version + 1 : 1,
                supersedesId: previous?.id ?? null,
                chunkCount: chunks.length,
                estimateMicroUsd: cost.expected,
                worstCaseMicroUsd: cost.worst,
                requestedById: ctx.userId,
            });
            for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
                await SourceChunkRepository.createMany(db, ctx.workspaceId, row.id, chunks.slice(i, i + CHUNK_INSERT_BATCH));
            }
            await logEvent(
                ctx,
                {
                    action: 'SOURCE_UPLOADED',
                    entityType: 'Source',
                    entityId: row.id,
                    details: { scope: target.kind === 'book' ? 'BOOK' : 'SERIES', bookId: target.kind === 'book' ? target.bookId : null, format: parsed.format, byteLength: upload.bytes.byteLength, chunks: chunks.length, version: previous ? previous.version + 1 : 1 },
                },
                { db },
            );
            return (await SourceRepository.find(db, ctx.workspaceId, row.id))!;
        },
        { timeout: 60_000 },
    ).catch((err: unknown) => {
        // Two uploads of one text at once: the unique index answers the one that lost.
        if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') throw new ConflictError('This library already holds that text.', { reason: 'SOURCE_DUPLICATE' });
        throw err;
    });
    return sourceView(created);
}

export interface LibraryListing {
    sources: SourceView[];
    /** Book listings only: the series sources, each with whether this book draws on it. */
    series?: Array<SourceView & { optedIn: boolean }>;
}

/** A book's sources and the series sources it may opt into (`bible.view`). */
export async function listBookSources(ctx: WorkspaceRequestContext, bookId: string): Promise<LibraryListing> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const library = await SourceLibraryRepository.findForBook(db, ctx.workspaceId, bookId);
        const own = library ? await SourceRepository.listForLibrary(db, ctx.workspaceId, library.id, LIBRARY_READ_MAX) : [];
        const series = await SourceLibraryRepository.findSeries(db, ctx.workspaceId);
        const seriesRows = series ? await SourceRepository.listForLibrary(db, ctx.workspaceId, series.id, LIBRARY_READ_MAX) : [];
        const opted = new Set(await BookSeriesSourceRepository.listForBook(db, ctx.workspaceId, bookId, LIBRARY_READ_MAX));
        const now = new Date();
        return { sources: own.map((r) => sourceView(r, now)), series: seriesRows.map((r) => ({ ...sourceView(r, now), optedIn: opted.has(r.id) })) };
    });
}

/** The workspace's series library (`bible.view`). */
export async function listSeriesSources(ctx: WorkspaceRequestContext): Promise<LibraryListing> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        const series = await SourceLibraryRepository.findSeries(db, ctx.workspaceId);
        const rows = series ? await SourceRepository.listForLibrary(db, ctx.workspaceId, series.id, LIBRARY_READ_MAX) : [];
        const now = new Date();
        return { sources: rows.map((r) => sourceView(r, now)) };
    });
}

/** One source as it stands (`bible.view`; the pages poll it while it runs). */
export async function getSource(ctx: WorkspaceRequestContext, sourceId: string): Promise<SourceView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => sourceView(await requireSource(db, ctx, sourceId)));
}

/** Remove a source (`bible.edit`): its chunks, facts, vectors and opt-ins with it. */
export async function removeSource(ctx: WorkspaceRequestContext, sourceId: string): Promise<{ removed: true }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        const source = await requireSource(db, ctx, sourceId);
        await SourceRepository.lock(db, sourceId);
        await SourceRepository.delete(db, ctx.workspaceId, sourceId);
        await logEvent(ctx, { action: 'SOURCE_REMOVED', entityType: 'Source', entityId: sourceId, details: { scope: source.library.scope, chunks: source.chunkCount, facts: source.factCount } }, { db });
        return { removed: true as const };
    });
}

/** A book draws on a series source, or stops (`bible.edit`). */
export async function setSeriesOptIn(ctx: WorkspaceRequestContext, bookId: string, sourceId: string, optedIn: boolean): Promise<{ optedIn: boolean }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const source = await requireSource(db, ctx, sourceId);
        if (source.library.scope !== 'SERIES') throw new ValidationError('Only a series source can be drawn on by a book.', { reason: 'NOT_A_SERIES_SOURCE' });
        if (optedIn) await BookSeriesSourceRepository.add(db, ctx.workspaceId, bookId, sourceId);
        else await BookSeriesSourceRepository.remove(db, ctx.workspaceId, bookId, sourceId);
        await logEvent(ctx, { action: 'SOURCE_SERIES_OPT_IN_CHANGED', entityType: 'Source', entityId: sourceId, details: { bookId, optedIn } }, { db });
        return { optedIn };
    });
}

/** What the source's unextracted chunks will cost, expected and at most (µUSD). */
async function remainingCost(db: PrismaTx, ctx: WorkspaceRequestContext, source: SourceRow): Promise<{ expected: number; worst: number; pending: number }> {
    const bookNames = source.library.scope === 'BOOK' && source.library.bookId ? (await bookNamesOf(db, ctx, source.library.bookId)).map((n) => n.name) : [];
    let expected = 0;
    let worst = 0;
    let pending = 0;
    let after = -1;
    for (;;) {
        const page = await SourceChunkRepository.listForSource(db, ctx.workspaceId, source.id, after, 100);
        for (const c of page) {
            after = c.position;
            if (c.extractedAt) continue;
            const one = chunkCost({ headings: decodeHeadingPath(c.headingPath), text: c.text, bookNames });
            expected += one.expected;
            worst += one.worst;
            pending++;
        }
        if (page.length < 100) break;
    }
    return { expected, worst, pending };
}

/** Start (or resume) a source's ingestion (`bible.edit`; the rules in the header). */
export async function dispatchIngestion(ctx: WorkspaceRequestContext, sourceId: string, input: { confirmWorstCaseMicroUsd: number }, deps: SourceLibraryDeps = {}): Promise<{ sourceId: string; budgetMicroUsd: number }> {
    await assertPermission(ctx, 'bible.edit');
    // A missing source (or a deleted book's) is a 404 before anything about the deployment is said.
    await runInWorkspaceContext(ctx, (db) => requireSource(db, ctx, sourceId));
    const unavailable = modelUnavailableReason();
    if (unavailable) throw new AiUnavailableError(unavailable);
    const verdict = (deps.gate ?? (() => extractionGate(deps.recordMode ?? deploymentPackRecordMode())))();
    if (!verdict.mounted) throw new ServiceUnavailableError('Reading facts from sources is not available in this deployment yet.', { reason: 'SOURCE_FACTS_NOT_EVALUATED', gate: verdict.reason });
    const queued = await runInWorkspaceContext(
        ctx,
        async (db) => {
            await SourceRepository.lock(db, sourceId);
            const source = await requireSource(db, ctx, sourceId);
            const state = effectiveSourceState(source);
            if (isLiveStatus(state.status)) throw new ConflictError('This source is already being read.', { reason: 'INGEST_IN_PROGRESS' });
            const cost = await remainingCost(db, ctx, source);
            // 4.H-a (#60 item 6): with every passage read, only a source whose embedding failed may run again (it re-embeds).
            if (cost.pending === 0 && !awaitsEmbedding(source)) throw new ConflictError('Every passage of this source has been read.', { reason: 'NOTHING_TO_INGEST' });
            if (!Number.isFinite(input.confirmWorstCaseMicroUsd) || input.confirmWorstCaseMicroUsd < cost.worst) {
                throw new ConflictError('The cost changed since it was shown; confirm the new amount.', { reason: 'ESTIMATE_CHANGED', expectedMicroUsd: cost.expected, worstCaseMicroUsd: cost.worst, pendingChunks: cost.pending });
            }
            const budget = Math.max(0, Math.round(input.confirmWorstCaseMicroUsd)) + Number(source.spentMicroUsd);
            await SourceRepository.queue(db, ctx.workspaceId, sourceId, { budgetMicroUsd: budget, promptVersion: EXTRACT_PROMPT_VERSION, requestedById: ctx.userId });
            await logEvent(ctx, { action: 'SOURCE_INGEST_DISPATCHED', entityType: 'Source', entityId: sourceId, details: { pendingChunks: cost.pending, worstCaseMicroUsd: cost.worst, expectedMicroUsd: cost.expected } }, { db });
            return { budget };
        },
        { timeout: 60_000 },
    );
    const payload = { workspaceId: ctx.workspaceId, sourceId };
    // A fresh job id each dispatch: a resumed source's earlier job may still be kept in the queue's history.
    const jobId = `source-ingest-${sourceId}-${Date.now().toString(36)}`;
    try {
        await (deps.enqueue ?? ((p, j) => enqueue('source-ingest', p, { jobId: j })))(payload, jobId);
    } catch (err) {
        logger.error('sources.enqueue_failed', { component: 'sources', sourceId, error: err instanceof AppError ? err.code : 'unknown' });
        await runInWorkspaceContext(ctx, (db) =>
            SourceRepository.finish(db, ctx.workspaceId, sourceId, { status: 'FAILED', outcome: 'ENQUEUE_FAILED', metrics: { errorCode: 'ENQUEUE_FAILED' } as Prisma.InputJsonValue, from: ['QUEUED'], finishedAt: new Date() }),
        );
        throw err;
    }
    return { sourceId, budgetMicroUsd: queued.budget };
}

/** Facts counted by status over these sources (the pages' headline). */
export async function factCounts(db: PrismaTx, ctx: WorkspaceRequestContext, sourceIds: readonly string[]): Promise<{ PENDING: number; CONFIRMED: number; REJECTED: number }> {
    const out = { PENDING: 0, CONFIRMED: 0, REJECTED: 0 };
    for (const r of await StoryFactRepository.countByStatus(db, ctx.workspaceId, sourceIds)) out[r.status] = r.count;
    return out;
}
