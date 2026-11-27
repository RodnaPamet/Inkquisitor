/**
 * Job types — the typed payload contract of every background job.
 *
 * Rules (from inflect-compliance's `src/app-layer/jobs/types.ts`):
 *   1. Job names are string literals, keys of `JobPayloadMap`.
 *   2. Payloads are JSON-serialisable: no Date, no class, no function.
 *   3. A workspace-scoped job's payload carries `workspaceId`, and its
 *      executor passes it to every query (decision D4).
 *   4. A payload never carries author text. A payload is stored in Redis in
 *      plain text and its fields reach the worker's log line; it names the
 *      rows to work on (ids), never their content (roadmap rule 4).
 *
 * Adding a job: extend `JobPayloadMap`, add its `JOB_DEFAULTS` entry (tsc
 * keeps that record exhaustive), register an executor in
 * `executor-registry.ts`, and, if it runs on a cadence, a schedule in
 * `schedules.ts`.
 *
 * Phase 1.H adds `book-purge`, the daily hard delete of books deleted more
 * than 30 days ago.
 *
 * Phase 0.4 shipped ONE job, `heartbeat`, which does nothing. Its only purpose
 * is to give the worker something to complete on a quiet queue, which proves
 * the queue → worker → executor wiring end to end and keeps the worker's
 * heartbeat key fresh (`heartbeat.ts`).
 */

/** The result every executor returns. */
export interface JobRunResult {
    jobName: string;
    jobRunId: string;
    success: boolean;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    itemsScanned: number;
    itemsActioned: number;
    itemsSkipped: number;
    errorMessage?: string;
    /** Set when the failure must not be retried by the queue (UnrecoverableError). */
    noRetry?: boolean;
    details?: Record<string, unknown>;
}

export interface HeartbeatPayload {
    /** ISO timestamp the schedule (or a test) enqueued it at. Optional: a schedule sends `{}`. */
    enqueuedAt?: string;
}

/**
 * The daily book purge (Phase 1.H): no payload. The job finds every book
 * deleted more than 30 days ago itself (`usecases/book-purge.ts`).
 */
export type BookPurgePayload = Record<string, never>;

/**
 * The daily scene purge (Phase 5.H-a, issue #71) and workspace purge (5.H-a, D36): no payload. Each finds what is due
 * itself (`usecases/scene-purge.ts`, `usecases/workspace-deletion.ts`).
 */
export type ScenePurgePayload = Record<string, never>;
export type WorkspacePurgePayload = Record<string, never>;

/**
 * One research run (Phase 2.6, decision D9): the run's id and its workspace,
 * never the brief's text. The executor reads the run, rebuilds the requester's
 * context from their CURRENT membership (refused if they may no longer edit
 * the bible) and runs it (`usecases/research-run.ts`). Idempotent: a run that
 * is no longer QUEUED is left alone.
 */
export interface ResearchRunPayload {
    workspaceId: string;
    runId: string;
}

/**
 * Phase 2.H: the daily call-log retention (`usecases/ai-call-retention.ts`)
 * deletes `AiCallLog` rows past `AI_CALL_LOG_RETENTION_DAYS`. No payload.
 */
export type AiCallLogRetentionPayload = Record<string, never>;

/**
 * One source ingestion (Phase 4.0, D23): the source's id and its workspace,
 * never its text. The executor reads the source, rebuilds the requester's
 * context from their CURRENT membership (stopped if they may no longer edit
 * the bible) and reads it chunk by chunk (`usecases/source-ingest.ts`).
 * Resumable and idempotent: a source that is no longer QUEUED is left alone,
 * and a chunk already read is never read again.
 */
export interface SourceIngestPayload {
    workspaceId: string;
    sourceId: string;
}

/**
 * Phase 4.1 (D27): the fact layer's minutely dispatcher. No payload: it finds
 * due bible fact extractions and embedding tasks itself
 * (`usecases/fact-layer-dispatch.ts`).
 */
export type FactLayerDispatchPayload = Record<string, never>;

/**
 * One bible fact extraction (Phase 4.1, D27): the outbox row's id and its
 * workspace, never the version's text. The executor reads the version, rebuilds
 * its author's context from their CURRENT membership (skipped if they may no
 * longer edit the bible) and extracts (`usecases/bible-facts.ts`). Idempotent: a
 * row that is no longer QUEUED is left alone.
 */
export interface BibleFactsPayload {
    workspaceId: string;
    extractionId: string;
}

/**
 * Phase 4.H-b (D31, D32): the hourly backfill of bibles saved before 4.1. No
 * payload: it finds the workspaces with entries never extracted (and their due
 * backfill rows) itself, and queues `bible-facts` jobs under each workspace's
 * daily share (`usecases/fact-backfill.ts`).
 */
export type FactBackfillPayload = Record<string, never>;

/**
 * Phase 4.2 (D28): the nightly continuity dispatcher. No payload: it finds the
 * books changed since their last deep check itself (`usecases/continuity-dispatch.ts`).
 */
export type ContinuityDispatchPayload = Record<string, never>;

/**
 * One book's nightly continuity check (Phase 4.2, D28): the run's id and its
 * workspace, never a fact's text (`usecases/continuity-check.ts`). Idempotent: a
 * run that is no longer QUEUED is left alone.
 */
export interface ContinuityCheckPayload {
    workspaceId: string;
    runId: string;
}

/**
 * Phase 5.3 (D35): the nightly draft-reading dispatcher. No payload: it finds the books with a scene whose text changed
 * since it was last read itself (`usecases/draft-read-dispatch.ts`).
 */
export type DraftReadDispatchPayload = Record<string, never>;

/**
 * One book's nightly draft reading (Phase 5.3, D35): the run's id and its workspace, never a scene's text
 * (`usecases/draft-read.ts`). Idempotent: a run that is no longer QUEUED is left alone.
 */
export interface DraftReadPayload {
    workspaceId: string;
    runId: string;
}

export interface StressTestPayload {
    workspaceId: string;
    stressTestId: string;
}

/**
 * One scene's prose check (Phase 5.2, D34): names the scene; the worker reads
 * its CURRENT text, so a debounced burst of saves is one check of the newest.
 * Added with BullMQ's per-scene deduplication (`prose-check-schedule.ts`).
 */
export interface ProseCheckPayload {
    workspaceId: string;
    sceneId: string;
}

export interface JobPayloadMap {
    heartbeat: HeartbeatPayload;
    'book-purge': BookPurgePayload;
    'scene-purge': ScenePurgePayload;
    'workspace-purge': WorkspacePurgePayload;
    'research-run': ResearchRunPayload;
    'ai-call-log-retention': AiCallLogRetentionPayload;
    'source-ingest': SourceIngestPayload;
    'fact-layer-dispatch': FactLayerDispatchPayload;
    'bible-facts': BibleFactsPayload;
    'continuity-dispatch': ContinuityDispatchPayload;
    'continuity-check': ContinuityCheckPayload;
    'stress-test': StressTestPayload;
    'fact-backfill': FactBackfillPayload;
    'prose-check': ProseCheckPayload;
    'draft-read-dispatch': DraftReadDispatchPayload;
    'draft-read': DraftReadPayload;
}

export type JobName = keyof JobPayloadMap;
export type JobPayload<T extends JobName> = JobPayloadMap[T];

export interface JobDefaults {
    attempts: number;
    backoff: { type: 'exponential' | 'fixed'; delay: number };
    removeOnComplete: number | boolean;
    removeOnFail: number | boolean;
}

export const JOB_DEFAULTS: Record<JobName, JobDefaults> = {
    heartbeat: {
        // One attempt: the next tick is the retry, and a heartbeat that
        // retried would refresh the key for a worker that failed to run it.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 100,
    },
    'book-purge': {
        // A failed run is retried twice; a book that fails every time is
        // logged and due again the next day (the purge is idempotent).
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 100,
    },
    'scene-purge': {
        // As the book purge: idempotent, a failed run retried twice, a scene that fails every time due again tomorrow.
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 100,
    },
    'workspace-purge': {
        // As the book purge: idempotent (a purged workspace is not found again), a failed one due again tomorrow.
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 100,
    },
    'research-run': {
        // One attempt: a retry would search the web again and spend again. A
        // run that fails ends with its named outcome; the author runs the brief
        // again, which is a new run.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'ai-call-log-retention': {
        // Idempotent: a failed run is retried; what it left is due tomorrow.
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 100,
    },
    'source-ingest': {
        // One attempt: an ingestion that stops ends with its named outcome and
        // the author resumes it (a new job), so nothing is ever spent twice
        // without their confirmation.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'fact-layer-dispatch': {
        // One attempt: the next minute is the retry, and every row it would
        // have dispatched is still due then.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 100,
    },
    'bible-facts': {
        // One attempt: an extraction that stops records its outcome and the
        // dispatcher queues it again when it is due, so a call is never repeated
        // by the queue behind the row's back.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 200,
    },
    'prose-check': {
        // One attempt: the next save (or the editor's "check now") is the retry,
        // and a check is deterministic, so running it again gains nothing.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 200,
    },
    'draft-read-dispatch': {
        // One attempt: the next night is the retry, and every book it would have queued is still due then.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 30,
        removeOnFail: 100,
    },
    'draft-read': {
        // One attempt: a night that stops records its outcome and keeps every scene read; the next night's
        // dispatcher queues the book again, so a call is never repeated by the queue behind the run's back.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 200,
    },
    'fact-backfill': {
        // One attempt: the next hour is the retry, and every entry it would have
        // given a row (and every due row) is still due then.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 30,
        removeOnFail: 100,
    },
    'continuity-dispatch': {
        // One attempt: the next night is the retry, and every book it would have
        // queued is still due then (a pass keeps its cursor).
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 30,
        removeOnFail: 100,
    },
    'continuity-check': {
        // One attempt: a night that stops records its outcome and keeps its
        // cursor; the next night's dispatcher queues the book again, so a call is
        // never repeated by the queue behind the run's back.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 200,
    },
    'stress-test': {
        // One attempt: a deep call is never repeated behind the author's back. A
        // test that stops records its named outcome; the author starts another
        // (confirming its cost again).
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
};

/** The one queue every job travels on. */
export const QUEUE_NAME = 'inkquisitor-jobs';
