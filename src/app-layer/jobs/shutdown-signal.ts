/**
 * The worker's shutdown signal (Phase 4.1, #57 item 6): one AbortSignal per
 * process, aborted when the worker receives SIGTERM or SIGINT, BEFORE it closes
 * (BullMQ's close waits for the active job). A long job — a source ingestion, a
 * bible fact extraction — takes it, stops at its next step and ends with its
 * named, resumable outcome (ABORTED), instead of holding a claim until it goes
 * stale. Kept on `globalThis` so the module graph that registered the
 * executors and the process script share one controller.
 */
const holder = globalThis as unknown as { __inkquisitorJobShutdown?: AbortController };

function controller(): AbortController {
    holder.__inkquisitorJobShutdown ??= new AbortController();
    return holder.__inkquisitorJobShutdown;
}

/** The signal every long job is handed. */
export function jobShutdownSignal(): AbortSignal {
    return controller().signal;
}

/** Abort every running job's signal (the worker's shutdown, first step). */
export function abortRunningJobs(): void {
    controller().abort(new Error('worker shutting down'));
}

/** @internal tests: a fresh, unaborted controller. */
export function _resetJobShutdownSignal(): void {
    holder.__inkquisitorJobShutdown = new AbortController();
}
