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

export interface JobPayloadMap {
    heartbeat: HeartbeatPayload;
    'book-purge': BookPurgePayload;
    'research-run': ResearchRunPayload;
    'ai-call-log-retention': AiCallLogRetentionPayload;
    'source-ingest': SourceIngestPayload;
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
};

/** The one queue every job travels on. */
export const QUEUE_NAME = 'inkquisitor-jobs';
