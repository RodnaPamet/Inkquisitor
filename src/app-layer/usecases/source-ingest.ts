/**
 * ONE SOURCE INGESTION (Phase 4.0, D23): the body of the `source-ingest` job.
 * The worker hands it `{ workspaceId, sourceId }`; nothing else crosses Redis.
 * RESUMABLE: the cursor is each chunk's `extractedAt`, so a stopped, failed or
 * crashed ingestion picks up at the first chunk not yet read.
 *
 *   1. CLAIM    the source in its workspace; anything but QUEUED is left alone.
 *               The person who started it is read again from their CURRENT
 *               membership: one who left or may no longer edit the bible stops
 *               it REQUESTER_NOT_PERMITTED, nothing sent. So does a deployment
 *               that can make no call (AI_UNAVAILABLE / KILL_SWITCH) or holds no
 *               evaluation record it accepts (NOT_EVALUATED, D11). QUEUED →
 *               RUNNING, conditionally.
 *   2. EMBED    every chunk through the 2.0 vector store (`passage`), filed
 *               under `SourceChunk` with its book (NULL for the series library).
 *               A provider failure degrades: the chunks stay unembedded and
 *               the retriever reads them lexically.
 *   3. EXTRACT  one fast-tier call per chunk not yet read, outside every
 *               transaction, in order. Before each: the BUDGET the author
 *               confirmed (that chunk's worst case must still fit), the model
 *               rate (`chargeModelCalls`: a limited minute is WAITED out, never
 *               failed), the abort signal. 2.1 checks the monthly ceiling and
 *               the kill switch before every call: CEILING and KILL_SWITCH stop
 *               the ingestion cleanly, resumable. A chunk's own failure (a
 *               timeout, the provider, an invalid answer) leaves that chunk for
 *               a resume and goes on; a guard refusal reads the chunk as yielding
 *               nothing. Each chunk's facts are validated (`validateFacts`: the
 *               span verified, grounding, polarity, injection) and written in
 *               one short transaction with its cursor and the spend.
 *   4. FINISH   DONE `OK` when every chunk is read, else STOPPED `PARTIAL` (or
 *               the stop's reason). Audited, counts and codes only.
 *
 * A fact's subject is linked to a book element when the book names exactly
 * one element so (`nameKey`); a series fact is linked per book when it is
 * read. A fact of a CHANGED re-upload that quotes the same passage for the
 * same claim as a decided fact of the version it supersedes takes that
 * decision (`carriedFromFactId`). Nothing here writes the bible.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { SourceChunkRepository, SourceRepository, StoryFactRepository, type SourceChunkRow, type SourceRow } from '@/app-layer/repositories/source.repository';
import { getVectorRepository, type VectorRecord } from '@/app-layer/repositories/vector.repository';
import { WorkspaceRepository } from '@/app-layer/repositories/workspace.repository';
import { getEmbeddingProvider, MAX_EMBED_BATCH, vectorContentHash, type EmbeddingProvider } from '@/lib/ai/embeddings';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { nameKey } from '@/lib/enrichment/validate';
import { RateLimitedError } from '@/lib/errors/types';
import type { PackRecordMode } from '@/lib/interview/pack-records-config';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';
import { chargeModelCalls } from '@/lib/security/model-call-rate-limit';
import { chunkCost } from '@/lib/sources/cost';
import type { FactExtractor } from '@/lib/sources/extractor';
import { defaultFactExtractor } from '@/lib/sources/model-seam';
import { extractBlocks } from '@/lib/sources/prompt';
import { foldWithOrigins } from '@/lib/sources/quote';
import { extractionGate, type ExtractionGateVerdict } from '@/lib/sources/record-gate';
import { decodeHeadingPath, sanitiseFactForStorage } from '@/lib/sources/storage';
import { validateFacts, type FactDraft } from '@/lib/sources/validate';
import { effectiveSourceState, SOURCE_CHUNK_MODEL, type SourceOutcome } from '@/lib/sources/vocabulary';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason } from './model-calls';
import { bookNamesOf } from './source-library';

export interface SourceIngestDeps {
    extractor?: (ctx: WorkspaceRequestContext) => FactExtractor;
    embedder?: () => EmbeddingProvider | null;
    recordMode?: PackRecordMode;
    gate?: () => ExtractionGateVerdict;
    signal?: AbortSignal;
    /** Waits out a limited minute (tests: instant). */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Charges one model call to the workspace's minute (D17; tests: a full minute). */
    charge?: (workspaceId: string, calls: number) => void;
}

interface IngestMetrics {
    chunksRead: number;
    chunksFailed: number;
    guardRefused: number;
    factsKept: number;
    factsCarried: number;
    drafted: number;
    refusals: Record<string, number>;
    failures: Record<string, number>;
    callIds: string[];
    embedded: number;
    embedFailed: boolean;
    /** Chunks marked unreadable (#57 item 2: they repeat a sentence of the prompt). */
    unreadable: number;
    errorCode?: string;
}

const CHUNK_PAGE = 20;
/** At most this many call ids are kept in a source's metrics (the rest are counted). */
const CALL_IDS_KEPT = 200;
const STOPPING = new Set(['KILL_SWITCH', 'WORKSPACE_CEILING', 'AI_UNAVAILABLE', 'ABORTED']);

function stopOutcome(failure: string): SourceOutcome {
    if (failure === 'KILL_SWITCH') return 'KILL_SWITCH';
    if (failure === 'WORKSPACE_CEILING') return 'CEILING';
    if (failure === 'ABORTED') return 'ABORTED';
    return 'AI_UNAVAILABLE';
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

/**
 * The CLAIM a decision is about: the predicate, the subject, the object, what the fact states and the
 * passage it quotes. A decision carries to a re-upload's fact only when every part is the same (folded), so
 * two facts drawn from one passage (Mara is the captain, Mara is the surgeon) never trade decisions.
 */
export function carryKey(f: { predicate: string; subjectName: string; objectLiteral: string | null; statement: string; quote: string }): string {
    return JSON.stringify([f.predicate, nameKey(f.subjectName), nameKey(f.objectLiteral ?? ''), foldWithOrigins(f.statement).text, foldWithOrigins(f.quote).text]);
}

/** The superseded version's decided facts by claim; a claim decided twice, differently, carries nothing. */
export function carriedByClaim<T extends { predicate: string; subjectName: string; objectLiteral: string | null; statement: string; quote: string; status: string }>(facts: readonly T[]): Map<string, T> {
    const out = new Map<string, T>();
    const conflicted = new Set<string>();
    for (const f of facts) {
        const key = carryKey(f);
        const held = out.get(key);
        if (held && held.status !== f.status) conflicted.add(key);
        else if (!held) out.set(key, f);
    }
    for (const key of conflicted) out.delete(key);
    return out;
}

async function finish(
    ctx: { workspaceId: string; requestId: string; userId?: string },
    source: Pick<SourceRow, 'id' | 'library'>,
    outcome: SourceOutcome,
    metrics: Partial<IngestMetrics>,
    remaining: number,
    claim?: Date,
): Promise<SourceOutcome> {
    const status = outcome === 'OK' ? 'DONE' : outcome === 'INTERNAL' || outcome === 'ENQUEUE_FAILED' ? 'FAILED' : 'STOPPED';
    // Once claimed, only this worker's claim is ended: a source queued again and claimed by another is left to it.
    const ended = await runInWorkspaceContext(ctx, (db) =>
        SourceRepository.finish(db, ctx.workspaceId, source.id, { status, outcome, metrics: metrics as unknown as Prisma.InputJsonValue, from: claim ? ['RUNNING'] : ['QUEUED', 'RUNNING'], finishedAt: new Date(), claim }),
    );
    if (ended) {
        await logEvent(ctx, {
            action: 'SOURCE_INGEST_FINISHED',
            entityType: 'Source',
            entityId: source.id,
            details: { scope: source.library.scope, outcome, chunksRead: metrics.chunksRead ?? 0, chunksFailed: metrics.chunksFailed ?? 0, factsKept: metrics.factsKept ?? 0, remaining },
        });
    }
    return outcome;
}

/** Embed every chunk of the source (step 2). Never throws for a provider condition. */
async function embedChunks(ctx: WorkspaceRequestContext, source: SourceRow, claim: Date, provider: EmbeddingProvider | null, metrics: IngestMetrics): Promise<void> {
    if (!provider) {
        metrics.embedFailed = true;
        return;
    }
    let after = -1;
    for (;;) {
        const read = await runInWorkspaceContext(ctx, async (db) => {
            const rows = await SourceChunkRepository.listForSource(db, ctx.workspaceId, source.id, after, MAX_EMBED_BATCH);
            // #57 item 1: only the chunks with no vector of this revision yet, on every pass, so a first pass whose
            // embedding failed is retried by the resume rather than leaving retrieval lexical for good.
            const present = new Set(await getVectorRepository().presentSources(db, ctx.workspaceId, provider.revision, SOURCE_CHUNK_MODEL, rows.map((c) => c.id)));
            return { rows, missing: rows.filter((c) => !present.has(c.id)) };
        });
        if (read.rows.length === 0) break;
        after = read.rows[read.rows.length - 1].position;
        const page = read.missing;
        if (page.length === 0) {
            if (read.rows.length < MAX_EMBED_BATCH) break;
            continue;
        }
        const result = await provider.embed(page.map((c) => c.text), { inputType: 'passage' });
        if (!result.ok) {
            logger.warn('sources.embedding_failed', { component: 'sources', sourceId: source.id, reason: result.reason, count: page.length });
            metrics.embedFailed = true;
            return;
        }
        const records: VectorRecord[] = page.map((c, i) => ({
            sourceModel: SOURCE_CHUNK_MODEL,
            sourceId: c.id,
            chunkIndex: 0,
            embeddingRevision: provider.revision,
            bookId: source.library.bookId,
            contentHash: vectorContentHash(ctx.workspaceId, c.text),
            embedding: result.vectors[i],
        }));
        await runInWorkspaceContext(ctx, async (db) => {
            await getVectorRepository().upsert(db, ctx.workspaceId, records);
            await SourceRepository.touch(db, ctx.workspaceId, source.id, claim);
        });
        metrics.embedded += page.length;
        if (read.rows.length < MAX_EMBED_BATCH) break;
    }
}

/** Run one ingestion (the job's body). */
export async function executeSourceIngest(payload: { workspaceId: string; sourceId: string }, deps: SourceIngestDeps = {}): Promise<{ ran: boolean; outcome: SourceOutcome | null }> {
    const scope = { workspaceId: payload.workspaceId, requestId: randomUUID() };
    const metrics: IngestMetrics = { chunksRead: 0, chunksFailed: 0, guardRefused: 0, factsKept: 0, factsCarried: 0, drafted: 0, refusals: {}, failures: {}, callIds: [], embedded: 0, embedFailed: false, unreadable: 0 };

    // 1. The source, the requester's current standing, the deployment.
    const claimed = await runInWorkspaceContext(scope, async (db) => {
        const source = await SourceRepository.find(db, payload.workspaceId, payload.sourceId);
        if (!source || source.status !== 'QUEUED') return { source: null, ctx: null };
        const slug = await WorkspaceRepository.findSlug(db, payload.workspaceId);
        const membership = source.requestedById ? await MembershipRepository.findForUser(db, payload.workspaceId, source.requestedById) : null;
        if (!slug || !membership || !source.requestedById) return { source, ctx: null };
        const ctx: WorkspaceRequestContext = {
            requestId: scope.requestId,
            userId: source.requestedById,
            workspaceId: payload.workspaceId,
            workspaceSlug: slug,
            role: membership.role,
            permissions: getPermissionsForRole(membership.role),
        };
        return { source, ctx };
    });
    const source = claimed.source;
    if (!source) return { ran: false, outcome: null };
    const remainingOf = () => source.chunkCount - source.chunksDone;
    if (effectiveSourceState(source).outcome === 'CLAIM_EXPIRED') return { ran: true, outcome: await finish({ ...scope, userId: claimed.ctx?.userId }, source, 'CLAIM_EXPIRED', { errorCode: 'CLAIM_EXPIRED' }, remainingOf()) };
    const ctx = claimed.ctx;
    if (!ctx || !ctx.permissions.bible.edit) return { ran: true, outcome: await finish({ ...scope, userId: ctx?.userId }, source, 'REQUESTER_NOT_PERMITTED', {}, remainingOf()) };
    const unavailable = modelUnavailableReason();
    if (unavailable) return { ran: true, outcome: await finish(ctx, source, unavailable === 'AI_DISABLED' ? 'KILL_SWITCH' : 'AI_UNAVAILABLE', { errorCode: unavailable }, remainingOf()) };
    const verdict = (deps.gate ?? (() => extractionGate(deps.recordMode ?? deploymentPackRecordMode())))();
    if (!verdict.mounted) return { ran: true, outcome: await finish(ctx, source, 'NOT_EVALUATED', { errorCode: verdict.reason }, remainingOf()) };

    const read = await runInWorkspaceContext(ctx, async (db) => {
        const claim = await SourceRepository.claim(db, ctx.workspaceId, source.id, new Date());
        if (!claim) return null;
        const names = source.library.scope === 'BOOK' && source.library.bookId ? await bookNamesOf(db, ctx, source.library.bookId) : [];
        const carried = source.supersedesId ? await StoryFactRepository.listDecidedForSource(db, ctx.workspaceId, source.supersedesId, 2_000) : [];
        return { claim, names, carried };
    });
    if (!read) return { ran: false, outcome: null };
    const claim = read.claim;
    const bookNames = read.names.map((n) => n.name);
    const byNameKey = new Map<string, string | null>();
    for (const n of read.names) {
        const key = nameKey(n.name);
        byNameKey.set(key, byNameKey.has(key) ? null : n.id);
    }
    const linkOf = (name: string | null): string | null => (name ? (byNameKey.get(nameKey(name)) ?? null) : null);
    const carriedBy = carriedByClaim(read.carried);

    try {
        // 2. Embed what has no vector yet (every pass: a resume retries a failed first pass, #57 item 1).
        await embedChunks(ctx, source, claim, deps.embedder ? deps.embedder() : (() => { const p = getEmbeddingProvider(); return p.ok ? p.provider : null; })(), metrics);

        // 3. Extract, chunk by chunk.
        const extractor = (deps.extractor ?? defaultFactExtractor)(ctx);
        const sleep = deps.sleep ?? defaultSleep;
        let spent = Number(source.spentMicroUsd);
        const budget = Number(source.budgetMicroUsd);
        let after = -1;
        for (;;) {
            const page = await runInWorkspaceContext(ctx, (db) => SourceChunkRepository.listForSource(db, ctx.workspaceId, source.id, after, CHUNK_PAGE));
            if (page.length === 0) break;
            for (const chunk of page) {
                after = chunk.position;
                if (chunk.extractedAt) continue;
                if (deps.signal?.aborted) return { ran: true, outcome: await finish(ctx, source, 'ABORTED', metrics, await pendingOf(ctx, source.id), claim) };
                const headings = decodeHeadingPath(chunk.headingPath);
                const blocks = { text: chunk.text, headings, bookNames };
                // The same blocks the call sends: its worst case (a repair included) must still fit what is left of the budget.
                const worst = chunkCost(blocks).worst;
                if (spent + worst > budget) return { ran: true, outcome: await finish(ctx, source, 'BUDGET', metrics, await pendingOf(ctx, source.id), claim) };
                if (!(await waitForModelRate(ctx, source.id, claim, deps.charge ?? chargeModelCalls, sleep, deps.signal))) {
                    // The minute stayed full past the wait: never a call that was not charged (D17). Resumable.
                    return { ran: true, outcome: await finish(ctx, source, 'PARTIAL', { ...metrics, errorCode: 'MODEL_RATE_LIMITED' }, await pendingOf(ctx, source.id), claim) };
                }
                const result = await extractor.extract({ data: extractBlocks(blocks), bookId: source.library.bookId }, deps.signal);
                spent += result.costMicroUsd;
                if (metrics.callIds.length < CALL_IDS_KEPT) metrics.callIds.push(...result.callIds);
                if (!result.ok) {
                    metrics.failures[result.failure] = (metrics.failures[result.failure] ?? 0) + 1;
                    if (STOPPING.has(result.failure)) {
                        await runInWorkspaceContext(ctx, (db) => SourceRepository.advance(db, ctx.workspaceId, source.id, claim, { chunksDone: 0, facts: 0, spentMicroUsd: result.costMicroUsd }));
                        return { ran: true, outcome: await finish(ctx, source, stopOutcome(result.failure), { ...metrics, errorCode: result.errorCode }, await pendingOf(ctx, source.id), claim) };
                    }
                    // #57 item 2: a chunk that repeats a sentence of the prompt can never be sent (2.1 refuses the
                    // request it would make); it is marked read, unreadable with its reason, and the rest completes.
                    const unreadable = result.failure === 'PROMPT_INVALID' && result.errorCode === 'REPEATS_PROMPT';
                    const yieldsNothing = result.failure === 'GUARD_REFUSED' || unreadable;
                    if (unreadable) metrics.unreadable++;
                    else if (yieldsNothing) metrics.guardRefused++;
                    else metrics.chunksFailed++;
                    const still = await persistChunk(ctx, source, claim, chunk, [], yieldsNothing, result.costMicroUsd, unreadable ? 'REPEATS_PROMPT' : null);
                    if (!still) return { ran: true, outcome: null };
                    continue;
                }
                const validation = validateFacts(result.output, { text: chunk.text, headingPath: headings });
                metrics.drafted += validation.drafted;
                for (const [code, n] of Object.entries(validation.refusals)) metrics.refusals[code] = (metrics.refusals[code] ?? 0) + (n ?? 0);
                const rows = validation.facts.map((draft) => factRow(ctx, source, chunk, sanitiseFactForStorage(draft), linkOf, carriedBy));
                const still = await persistChunk(ctx, source, claim, chunk, rows, true, result.costMicroUsd);
                if (!still) return { ran: true, outcome: null };
                metrics.chunksRead++;
                metrics.factsKept += rows.length;
                metrics.factsCarried += rows.filter((r) => r.carriedFromFactId !== null).length;
            }
            if (page.length < CHUNK_PAGE) break;
        }
        const remaining = await pendingOf(ctx, source.id);
        return { ran: true, outcome: await finish(ctx, source, remaining === 0 ? 'OK' : 'PARTIAL', metrics, remaining, claim) };
    } catch (err) {
        logger.error('sources.ingest_failed', { component: 'sources', sourceId: source.id, error: err instanceof Error ? err.name : 'unknown' });
        return { ran: true, outcome: await finish(ctx, source, 'INTERNAL', { ...metrics, errorCode: 'INTERNAL' }, remainingOf(), claim) };
    }
}

async function pendingOf(ctx: WorkspaceRequestContext, sourceId: string): Promise<number> {
    return runInWorkspaceContext(ctx, (db) => SourceChunkRepository.countPending(db, ctx.workspaceId, sourceId));
}

/** How long one chunk waits out a full model-call minute at most before the ingestion stops PARTIAL (well inside `STALE_INGEST_MS`). */
export const MODEL_RATE_WAIT_MAX_MS = 5 * 60 * 1000;

/**
 * The workspace's model-call minute (D17): a limited minute is waited out, never failed — the job has nowhere
 * to send a 429. Bounded: past `MODEL_RATE_WAIT_MAX_MS` (or once aborted) it answers false and NO call is
 * charged or made, so a call never leaves uncharged. Each wait is a sign of life on the claim.
 */
async function waitForModelRate(
    ctx: WorkspaceRequestContext,
    sourceId: string,
    claim: Date,
    charge: (workspaceId: string, calls: number) => void,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
): Promise<boolean> {
    let waited = 0;
    for (;;) {
        try {
            charge(ctx.workspaceId, 1);
            return true;
        } catch (err) {
            if (!(err instanceof RateLimitedError)) throw err;
            if (waited >= MODEL_RATE_WAIT_MAX_MS || signal?.aborted) return false;
            const retry = Number((err.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs ?? 1_000);
            const ms = Math.min(60_000, Math.max(250, Number.isFinite(retry) ? retry : 1_000), MODEL_RATE_WAIT_MAX_MS - waited);
            await sleep(ms, signal);
            waited += ms;
            if (signal?.aborted) return false;
            await runInWorkspaceContext(ctx, (db) => SourceRepository.touch(db, ctx.workspaceId, sourceId, claim));
        }
    }
}

type FactInsert = Parameters<typeof StoryFactRepository.createMany>[2][number];

function factRow(
    ctx: WorkspaceRequestContext,
    source: SourceRow,
    chunk: SourceChunkRow,
    draft: FactDraft,
    linkOf: (name: string | null) => string | null,
    carriedBy: ReadonlyMap<string, { id: string; status: 'PENDING' | 'CONFIRMED' | 'REJECTED'; decidedById: string | null; decidedAt: Date | null }>,
): FactInsert {
    const carried = carriedBy.get(carryKey(draft));
    const book = source.library.scope === 'BOOK';
    return {
        sourceId: source.id,
        chunkId: chunk.id,
        position: draft.position,
        subjectName: draft.subjectName,
        subjectElementId: book ? linkOf(draft.subjectName) : null,
        predicate: draft.predicate,
        objectElementId: book ? linkOf(draft.objectLiteral) : null,
        objectLiteral: draft.objectLiteral,
        statement: draft.statement,
        quote: draft.quote,
        quoteStart: draft.quoteStart,
        quoteEnd: draft.quoteEnd,
        storyTimeFrom: draft.storyTimeFrom,
        storyTimeTo: draft.storyTimeTo,
        flags: draft.flags,
        status: carried && carried.status !== 'PENDING' ? carried.status : 'PENDING',
        decidedById: carried && carried.status !== 'PENDING' ? carried.decidedById : null,
        decidedAt: carried && carried.status !== 'PENDING' ? (carried.decidedAt ?? new Date()) : null,
        carriedFromFactId: carried && carried.status !== 'PENDING' ? carried.id : null,
    };
}

/**
 * One chunk's result, in one short transaction: its facts, its cursor (when it
 * is read) and the spend, while the source is still RUNNING (a removed source
 * or a stale claim writes nothing). Returns whether the source still runs.
 */
async function persistChunk(
    ctx: WorkspaceRequestContext,
    source: SourceRow,
    claim: Date,
    chunk: SourceChunkRow,
    rows: FactInsert[],
    read: boolean,
    costMicroUsd: number,
    unreadable: 'REPEATS_PROMPT' | null = null,
): Promise<boolean> {
    try {
        return await runInWorkspaceContext(ctx, async (db) => {
            await SourceRepository.lock(db, source.id);
            const now = await SourceRepository.find(db, ctx.workspaceId, source.id);
            // Still RUNNING, and still under THIS worker's claim: a stale claim re-dispatched and claimed again belongs to its new worker.
            if (!now || now.status !== 'RUNNING' || now.startedAt?.getTime() !== claim.getTime()) return false;
            if (read) {
                const marked = unreadable
                    ? await SourceChunkRepository.markUnreadable(db, ctx.workspaceId, chunk.id, new Date(), unreadable)
                    : await SourceChunkRepository.markExtracted(db, ctx.workspaceId, chunk.id, new Date());
                if (!marked) return true;
                await StoryFactRepository.createMany(db, ctx.workspaceId, rows);
            }
            return SourceRepository.advance(db, ctx.workspaceId, source.id, claim, { chunksDone: read ? 1 : 0, facts: read ? rows.length : 0, spentMicroUsd: costMicroUsd });
        });
    } catch (err) {
        // #57 item 5: the call was made and paid for; a database error writing its result must not lose its cost.
        // Counted in a transaction of its own, under the same claim, then the failure goes on to end the run.
        if (costMicroUsd > 0) {
            await runInWorkspaceContext(ctx, (db) => SourceRepository.advance(db, ctx.workspaceId, source.id, claim, { chunksDone: 0, facts: 0, spentMicroUsd: costMicroUsd })).catch(() => undefined);
        }
        throw err;
    }
}
