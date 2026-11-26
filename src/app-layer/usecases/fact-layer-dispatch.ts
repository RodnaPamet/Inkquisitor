/**
 * THE FACT LAYER'S MINUTELY DISPATCHER (Phase 4.1, D27, D8): the body of the
 * `fact-layer-dispatch` job. Two outboxes, both written by triggers in the
 * transaction of the row they name, so a rolled-back save leaves nothing here:
 *
 *   EXTRACTIONS   each due `BibleFactExtraction` (a PENDING row settled for
 *                 `FACT_EXTRACTION_SETTLE_MS`, a STOPPED row whose next attempt
 *                 is due, a QUEUED or RUNNING row with no sign of life for
 *                 `STALE_EXTRACTION_MS`) is marked QUEUED in its workspace and a
 *                 `bible-facts` job is enqueued for it (payload ids only; one job
 *                 id per attempt). Nothing is queued while the deployment can
 *                 make no call or holds no evaluation record it accepts (D11):
 *                 the rows wait, PENDING, and nothing spins.
 *   EMBEDDINGS    each `EmbeddingTask` (an element changed, a fact written, an
 *                 answer given) is embedded as its row stands NOW, through the
 *                 2.0 store, and the task deleted. Never on a request's path. A
 *                 row gone takes its task with it; a provider failure counts an
 *                 attempt and the task waits (dropped after
 *                 `EMBEDDING_TASK_ATTEMPTS_MAX`, logged).
 *
 * Discovery is the one read outside row-level security
 * (`fact-layer-discovery`: ids only); every write is in its workspace's own
 * context. Bounded per tick on both sides.
 */
import { randomUUID } from 'node:crypto';
import { EmbeddingSourceRepository, EmbeddingTaskRepository, FactExtractionRepository } from '@/app-layer/repositories/fact-layer.repository';
import { getVectorRepository, type VectorRecord } from '@/app-layer/repositories/vector.repository';
import type { JobName, JobPayload } from '@/app-layer/jobs/types';
import { getEmbeddingProvider, MAX_EMBED_BATCH, vectorContentHash, type EmbeddingProvider } from '@/lib/ai/embeddings';
import { decodeFieldValue, type FieldValue } from '@/lib/bible/field-values';
import { plainBlock } from '@/lib/bible/text';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { bibleFactGate } from '@/lib/facts/record-gate';
import {
    ANSWER_MODEL,
    BIBLE_ELEMENT_MODEL,
    DISPATCH_EMBEDDINGS_MAX,
    DISPATCH_EXTRACTIONS_MAX,
    EMBEDDING_TASK_ATTEMPTS_MAX,
    FACT_EXTRACTION_SETTLE_MS,
    STALE_EXTRACTION_MS,
    STORY_FACT_MODEL,
} from '@/lib/facts/vocabulary';
import { logger } from '@/lib/observability/logger';
import { deploymentPackRecordMode } from './interview-packs';
import { modelUnavailableReason } from './model-calls';

/** Characters of a row's text embedded at most (an embedding is a summary of meaning, not a copy). */
export const EMBED_TEXT_MAX_CHARS = 8_000;

export interface DispatchDeps {
    enqueue?: <T extends JobName>(name: T, payload: JobPayload<T>, options?: { jobId?: string }) => Promise<unknown>;
    embedder?: () => EmbeddingProvider | null;
    /** Is extraction possible in this deployment now? (tests) */
    extractionOpen?: () => boolean;
    /** Only these workspaces (tests, which share one database; the deployment's dispatcher scans every workspace). */
    workspaceIds?: readonly string[];
    now?: () => Date;
}

export interface DispatchResult {
    queued: number;
    enqueueFailed: number;
    extractionClosed: boolean;
    embedded: number;
    embedDropped: number;
    embedFailed: number;
}

function defaultExtractionOpen(): boolean {
    return modelUnavailableReason() === null && bibleFactGate(deploymentPackRecordMode()).mounted;
}

/** Run one tick (the job's body). */
export async function executeFactLayerDispatch(deps: DispatchDeps = {}): Promise<DispatchResult> {
    const now = (deps.now ?? (() => new Date()))();
    const result: DispatchResult = { queued: 0, enqueueFailed: 0, extractionClosed: false, embedded: 0, embedDropped: 0, embedFailed: 0 };
    const enqueue = deps.enqueue ?? (async (name, payload, options) => (await import('@/app-layer/jobs/queue')).enqueue(name, payload, options));

    // ── Extractions ──
    if ((deps.extractionOpen ?? defaultExtractionOpen)()) {
        const due = await runWithoutRls({ reason: 'fact-layer-discovery' }, (db) =>
            FactExtractionRepository.listDue(db, { now, settledBefore: new Date(now.getTime() - FACT_EXTRACTION_SETTLE_MS), staleBefore: new Date(now.getTime() - STALE_EXTRACTION_MS), take: DISPATCH_EXTRACTIONS_MAX, workspaceIds: deps.workspaceIds }),
        );
        const byWorkspace = new Map<string, typeof due>();
        for (const d of due) byWorkspace.set(d.workspaceId, [...(byWorkspace.get(d.workspaceId) ?? []), d]);
        for (const [workspaceId, rows] of byWorkspace) {
            const scope = { workspaceId, requestId: randomUUID() };
            const marked = await runInWorkspaceContext(scope, async (db) => {
                const out: Array<{ id: string; attempt: number }> = [];
                for (const r of rows) if (await FactExtractionRepository.markQueued(db, workspaceId, r.id, now)) out.push({ id: r.id, attempt: r.attempts + 1 });
                return out;
            });
            for (const m of marked) {
                try {
                    await enqueue('bible-facts', { workspaceId, extractionId: m.id }, { jobId: `bible-facts-${m.id}-${m.attempt}` });
                    result.queued++;
                } catch (err) {
                    // The row stays QUEUED; with no sign of life it is dispatched again once stale.
                    result.enqueueFailed++;
                    logger.warn('facts.enqueue_failed', { component: 'facts', workspaceId, extractionId: m.id, error: err instanceof Error ? err.name : 'unknown' });
                }
            }
        }
    } else {
        result.extractionClosed = true;
    }

    // ── Embeddings ──
    const provider = deps.embedder ? deps.embedder() : (() => { const p = getEmbeddingProvider(); return p.ok ? p.provider : null; })();
    const workspaces = await runWithoutRls({ reason: 'fact-layer-discovery' }, (db) => EmbeddingTaskRepository.listDueWorkspaces(db, DISPATCH_EMBEDDINGS_MAX, deps.workspaceIds));
    let budget = DISPATCH_EMBEDDINGS_MAX;
    for (const workspaceId of workspaces) {
        if (budget <= 0) break;
        const done = await embedWorkspaceTasks(workspaceId, provider, Math.min(budget, MAX_EMBED_BATCH));
        budget -= done.seen;
        result.embedded += done.embedded;
        result.embedDropped += done.dropped;
        result.embedFailed += done.failed;
    }
    return result;
}

/** A stored field value as embedded text (a scale states nothing). */
function valueText(value: FieldValue): string {
    if (Array.isArray(value)) return value.join('; ');
    return typeof value === 'number' ? '' : plainBlock(value);
}

function clip(text: string): string {
    return text.length > EMBED_TEXT_MAX_CHARS ? text.slice(0, EMBED_TEXT_MAX_CHARS) : text;
}

/** One workspace's oldest tasks: read the rows, embed what is still there, file the vectors, delete the tasks. */
export async function embedWorkspaceTasks(workspaceId: string, provider: EmbeddingProvider | null, take: number): Promise<{ seen: number; embedded: number; dropped: number; failed: number }> {
    const scope = { workspaceId, requestId: randomUUID() };
    const read = await runInWorkspaceContext(scope, async (db) => {
        const tasks = await EmbeddingTaskRepository.listForWorkspace(db, workspaceId, take);
        const ids = (model: string) => tasks.filter((t) => t.sourceModel === model).map((t) => t.sourceId);
        const elements = await EmbeddingSourceRepository.elements(db, workspaceId, ids(BIBLE_ELEMENT_MODEL));
        const facts = await EmbeddingSourceRepository.facts(db, workspaceId, ids(STORY_FACT_MODEL));
        const answers = await EmbeddingSourceRepository.answers(db, workspaceId, ids(ANSWER_MODEL));
        const items = new Map<string, { bookId: string | null; text: string }>();
        for (const e of elements) items.set(`${BIBLE_ELEMENT_MODEL}:${e.id}`, { bookId: e.bookId, text: [e.name, e.summary ?? '', ...e.fields.map((f) => valueText(decodeFieldValue(f.value)))].filter((t) => t !== '').join('\n') });
        for (const f of facts) items.set(`${STORY_FACT_MODEL}:${f.id}`, { bookId: f.bookId ?? f.source?.library.bookId ?? null, text: `${f.subjectName}: ${f.statement}` });
        for (const a of answers) items.set(`${ANSWER_MODEL}:${a.id}`, { bookId: a.question.session.bookId, text: [a.choice ?? '', a.text ?? ''].filter((t) => t !== '').join('\n') });
        return { tasks, items };
    });
    const { tasks, items } = read;
    if (tasks.length === 0) return { seen: 0, embedded: 0, dropped: 0, failed: 0 };
    const gone = tasks.filter((t) => !items.has(`${t.sourceModel}:${t.sourceId}`) || items.get(`${t.sourceModel}:${t.sourceId}`)!.text.trim() === '');
    const live = tasks.filter((t) => !gone.includes(t));
    const failedOut = async (reason: string): Promise<{ seen: number; embedded: number; dropped: number; failed: number }> => {
        const spent = live.filter((t) => t.attempts + 1 >= EMBEDDING_TASK_ATTEMPTS_MAX);
        await runInWorkspaceContext(scope, async (db) => {
            await EmbeddingTaskRepository.remove(db, workspaceId, [...gone, ...spent].map((t) => t.id));
            await EmbeddingTaskRepository.bumpAttempts(db, workspaceId, live.filter((t) => !spent.includes(t)).map((t) => t.id));
        });
        if (spent.length > 0) logger.warn('facts.embedding_tasks_dropped', { component: 'facts', workspaceId, count: spent.length, reason });
        return { seen: tasks.length, embedded: 0, dropped: gone.length + spent.length, failed: live.length };
    };
    if (live.length === 0) {
        await runInWorkspaceContext(scope, (db) => EmbeddingTaskRepository.remove(db, workspaceId, gone.map((t) => t.id)));
        return { seen: tasks.length, embedded: 0, dropped: gone.length, failed: 0 };
    }
    if (!provider) return failedOut('NO_PROVIDER');
    const texts = live.map((t) => clip(items.get(`${t.sourceModel}:${t.sourceId}`)!.text));
    const embedded = await provider.embed(texts, { inputType: 'passage' });
    if (!embedded.ok) {
        logger.warn('facts.embedding_failed', { component: 'facts', workspaceId, reason: embedded.reason, count: texts.length });
        return failedOut(embedded.reason);
    }
    const records: VectorRecord[] = live.map((t, i) => ({
        sourceModel: t.sourceModel,
        sourceId: t.sourceId,
        chunkIndex: 0,
        embeddingRevision: provider.revision,
        bookId: items.get(`${t.sourceModel}:${t.sourceId}`)!.bookId,
        contentHash: vectorContentHash(workspaceId, texts[i]),
        embedding: embedded.vectors[i],
    }));
    try {
        await runInWorkspaceContext(scope, async (db) => {
            await getVectorRepository().upsert(db, workspaceId, records);
            await EmbeddingTaskRepository.remove(db, workspaceId, tasks.map((t) => t.id));
        });
    } catch (err) {
        // A row deleted between the read and the write (the store refuses its vector): the next tick finds it gone.
        logger.warn('facts.embedding_write_failed', { component: 'facts', workspaceId, error: err instanceof Error ? err.name : 'unknown' });
        return failedOut('WRITE_FAILED');
    }
    return { seen: tasks.length, embedded: records.length, dropped: gone.length, failed: 0 };
}
