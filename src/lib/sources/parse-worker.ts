/**
 * THE BOUNDED PARSE WORKER (Phase 4.0, D26): a reader of a hostile file runs
 * in a worker thread, never on the request's thread, under three bounds the
 * parent enforces:
 *
 *   deadline   one `timeoutMs` over the wait for a slot and the reading; past
 *              it the worker is terminated (`TIMEOUT`)
 *   memory     the worker's JavaScript heap is capped by `resourceLimits`, and
 *              the parent reads its heap AND external memory (typed arrays a
 *              decoder fills live outside the heap) every `MEMORY_POLL_MS`,
 *              terminating it past `memoryMb` (`MEMORY`). That read is
 *              answered by the worker's own thread at its next interrupt point,
 *              so a worker held in one native call (a synchronous inflate, a
 *              spawn collecting output) cannot answer it, and before 4.H-a the
 *              parent was blind until the call returned — or until the
 *              deadline, if it never did (#57 item 7). Now, while a read has
 *              gone unanswered for `MEMORY_STALL_MS`, the parent also reads the
 *              PROCESS's resident memory, synchronously, needing nothing of the
 *              worker, and terminates it when the process has grown past
 *              `memoryMb` since the worker came online (the worker's thread
 *              itself stops only once its native call returns: the slot and
 *              the answer are freed at once). The residual window is one
 *              poll (or one stall) of allocation: the readers are pure
 *              JavaScript decoders (pdf.js's inflate, JSZip over a ZIP
 *              `readZip` already bounded), which allocate a piece at a time at
 *              interrupt points, so no single allocation is unbounded.
 *   slots      at most `PARSE_WORKERS_MAX` workers run in a process at once; a
 *              further file waits its turn inside its own deadline
 *
 * A worker that crashes, runs out of heap or exits without answering is
 * `FAILED`. The script is a fixed file under `<cwd>/scripts` (the image copies
 * it), named by the caller from a constant, never from input. Measured before
 * this existed: a 1 MB PDF inflating one stream took the process past 2 GB
 * under the heap limit alone, and a 4 MB DOCX held mammoth on the request's
 * thread for 33 seconds at a 3.3 GB heap.
 */
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface ParseWorkerLimits {
    timeoutMs: number;
    /** The worker's old-generation heap, at most. */
    heapMb: number;
    /** The worker's heap plus its external memory, at most. */
    memoryMb: number;
}

export type ParseWorkerOutcome = { kind: 'message'; message: unknown } | { kind: 'TIMEOUT' } | { kind: 'MEMORY' } | { kind: 'FAILED' };

/** Parse workers running in this process at once, at most. */
export const PARSE_WORKERS_MAX = 2;
/** How often the parent reads a running worker's memory. */
export const MEMORY_POLL_MS = 50;
/** A heap read unanswered this long means the worker is held in a native call: the process's memory is read instead (4.H-a). */
export const MEMORY_STALL_MS = 250;

/** A worker script's path: `<cwd>/scripts/<name>`, as the fonts are read from `<cwd>/fonts`. */
export function parseWorkerPath(name: 'pdf-text-worker.mjs' | 'docx-text-worker.mjs', cwd: string = process.cwd()): string {
    return path.join(cwd, 'scripts', name);
}

let running = 0;
const waiting: Array<() => void> = [];

function release(): void {
    const next = waiting.shift();
    if (next) next();
    else running--;
}

/** A slot, or false when `signal` ends the wait first. */
function takeSlot(signal: AbortSignal): Promise<boolean> {
    if (running < PARSE_WORKERS_MAX) {
        running++;
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const turn = () => {
            signal.removeEventListener('abort', gaveUp);
            resolve(true);
        };
        const gaveUp = () => {
            const at = waiting.indexOf(turn);
            if (at >= 0) waiting.splice(at, 1);
            resolve(false);
        };
        waiting.push(turn);
        signal.addEventListener('abort', gaveUp, { once: true });
    });
}

/** @internal test-only: the slots in use and waiting. */
export function _parseWorkerSlots(): { running: number; waiting: number } {
    return { running, waiting: waiting.length };
}

/** Run one worker to its first message (or its end), under the bounds above. */
export async function runParseWorker(scriptPath: string, workerData: Record<string, unknown>, limits: ParseWorkerLimits): Promise<ParseWorkerOutcome> {
    const deadline = AbortSignal.timeout(limits.timeoutMs);
    if (!(await takeSlot(deadline))) return { kind: 'TIMEOUT' };
    try {
        return await new Promise<ParseWorkerOutcome>((resolve) => {
            let settled = false;
            const worker = new Worker(scriptPath, {
                workerData,
                resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: 64 },
                stdout: true,
                stderr: true,
            });
            // A reader may warn on stdout/stderr (pdf.js about fonts it skips): never a log line, since a warning could quote the document.
            worker.stdout.resume();
            worker.stderr.resume();
            const onDeadline = () => done({ kind: 'TIMEOUT' });
            const done = (outcome: ParseWorkerOutcome) => {
                if (settled) return;
                settled = true;
                clearInterval(poll);
                deadline.removeEventListener('abort', onDeadline);
                void worker.terminate();
                resolve(outcome);
            };
            const memoryBytes = limits.memoryMb * 1024 * 1024;
            // The process's resident memory once this worker is up (its own isolate counted in): what a stalled worker is
            // measured against. Until it is online, nothing is measured from outside.
            let baselineRss: number | null = null;
            worker.once('online', () => {
                baselineRss = process.memoryUsage.rss();
            });
            let readingSince: number | null = null;
            const poll = setInterval(() => {
                if (settled) return;
                if (readingSince !== null) {
                    // A read still unanswered: the worker is in a native call. Its memory is read from outside it.
                    if (baselineRss !== null && performance.now() - readingSince >= MEMORY_STALL_MS && process.memoryUsage.rss() - baselineRss > memoryBytes) done({ kind: 'MEMORY' });
                    return;
                }
                readingSince = performance.now();
                worker
                    .getHeapStatistics()
                    .then((h) => {
                        if (h.used_heap_size + h.external_memory > memoryBytes) done({ kind: 'MEMORY' });
                    })
                    .catch(() => undefined)
                    .finally(() => {
                        readingSince = null;
                    });
            }, MEMORY_POLL_MS);
            if (deadline.aborted) onDeadline();
            else deadline.addEventListener('abort', onDeadline, { once: true });
            worker.on('message', (message: unknown) => done({ kind: 'message', message }));
            worker.on('error', () => done({ kind: 'FAILED' }));
            worker.on('exit', () => done({ kind: 'FAILED' }));
        });
    } finally {
        release();
    }
}
