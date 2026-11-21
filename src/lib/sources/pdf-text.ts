/**
 * A PDF's text layer, read in a bounded worker thread (Phase 4.0, D26).
 *
 * `scripts/pdf-text-worker.mjs` does the reading; this starts it with a heap
 * limit, hands it a COPY of the bytes, and terminates it when its deadline
 * passes (`SOURCE_PARSE_TIMEOUT`) or when it dies (out of memory, a crash:
 * `SOURCE_PARSE_FAILED`). Nothing here is rendered and no OCR is attempted
 * (D26): a PDF whose pages hold no text is refused `SOURCE_NO_TEXT_LAYER` by
 * the caller, never guessed at.
 *
 * MEMORY. The heap limit (`resourceLimits`) bounds only the worker's
 * JavaScript heap: pdf.js decodes a stream into typed arrays, which live
 * OUTSIDE it, so a one-megabyte PDF whose content stream inflates to a
 * gigabyte took the whole process past two gigabytes under the heap limit
 * alone. The parent therefore polls the worker's heap AND external memory
 * (`getHeapStatistics`) every `MEMORY_POLL_MS` and terminates it past
 * `memoryMb` (`SOURCE_TOO_LONG`). And at most `PDF_WORKERS_MAX` workers run
 * in a process at once: a further PDF waits its turn within its own deadline.
 */
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface PdfTextLimits {
    timeoutMs: number;
    maxPages: number;
    maxChars: number;
    heapMb: number;
    /** The worker's heap plus its external memory (decoded streams), at most. */
    memoryMb: number;
}

export const PDF_TEXT_LIMITS: PdfTextLimits = { timeoutMs: 30_000, maxPages: 3_000, maxChars: 12_000_000, heapMb: 512, memoryMb: 768 };

/** PDF workers running in this process at once, at most. */
export const PDF_WORKERS_MAX = 2;
/** How often the parent reads a running worker's memory. */
export const MEMORY_POLL_MS = 50;

export type PdfTextResult = { ok: true; pages: string[] } | { ok: false; reason: 'SOURCE_ENCRYPTED' | 'SOURCE_PARSE_FAILED' | 'SOURCE_PARSE_TIMEOUT' | 'SOURCE_TOO_LONG' };

/** Where the worker script is: `<cwd>/scripts`, as the fonts are read from `<cwd>/fonts` (the image copies both). */
export function pdfWorkerPath(cwd: string = process.cwd()): string {
    return path.join(cwd, 'scripts', 'pdf-text-worker.mjs');
}

let running = 0;
const waiting: Array<() => void> = [];

/** A worker slot, or null when `signal` ends the wait first. */
function takeSlot(signal: AbortSignal): Promise<(() => void) | null> {
    const release = () => {
        const next = waiting.shift();
        if (next) next();
        else running--;
    };
    if (running < PDF_WORKERS_MAX) {
        running++;
        return Promise.resolve(release);
    }
    return new Promise((resolve) => {
        const turn = () => {
            signal.removeEventListener('abort', gaveUp);
            resolve(release);
        };
        const gaveUp = () => {
            const at = waiting.indexOf(turn);
            if (at >= 0) waiting.splice(at, 1);
            resolve(null);
        };
        waiting.push(turn);
        signal.addEventListener('abort', gaveUp, { once: true });
    });
}

/** @internal test-only: the slots in use and waiting. */
export function _pdfWorkerSlots(): { running: number; waiting: number } {
    return { running, waiting: waiting.length };
}

export async function readPdfText(bytes: Uint8Array, limits: PdfTextLimits = PDF_TEXT_LIMITS, workerPath: string = pdfWorkerPath()): Promise<PdfTextResult> {
    // One deadline over the wait for a slot and the reading.
    const deadline = AbortSignal.timeout(limits.timeoutMs);
    const release = await takeSlot(deadline);
    if (!release) return { ok: false, reason: 'SOURCE_PARSE_TIMEOUT' };
    try {
        return await runWorker(bytes, limits, workerPath, deadline);
    } finally {
        release();
    }
}

function runWorker(bytes: Uint8Array, limits: PdfTextLimits, workerPath: string, deadline: AbortSignal): Promise<PdfTextResult> {
    return new Promise((resolve) => {
        let settled = false;
        const copy = bytes.slice();
        const worker = new Worker(workerPath, {
            workerData: { bytes: copy, maxPages: limits.maxPages, maxChars: limits.maxChars },
            resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: 64 },
            stdout: true,
            stderr: true,
        });
        // pdf.js warns on stdout/stderr about fonts it skips: never a log line (a warning could quote the document).
        worker.stdout.resume();
        worker.stderr.resume();
        const onDeadline = () => done({ ok: false, reason: 'SOURCE_PARSE_TIMEOUT' });
        const done = (result: PdfTextResult) => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            deadline.removeEventListener('abort', onDeadline);
            void worker.terminate();
            resolve(result);
        };
        if (deadline.aborted) onDeadline();
        else deadline.addEventListener('abort', onDeadline, { once: true });
        const memoryBytes = limits.memoryMb * 1024 * 1024;
        let reading = false;
        const poll = setInterval(() => {
            if (reading || settled) return;
            reading = true;
            worker
                .getHeapStatistics()
                .then((h) => {
                    if (h.used_heap_size + h.external_memory > memoryBytes) done({ ok: false, reason: 'SOURCE_TOO_LONG' });
                })
                .catch(() => undefined)
                .finally(() => {
                    reading = false;
                });
        }, MEMORY_POLL_MS);
        worker.on('message', (m: unknown) => {
            const msg = m as { ok?: unknown; pages?: unknown; reason?: unknown };
            if (msg.ok === true && Array.isArray(msg.pages) && msg.pages.every((p) => typeof p === 'string')) done({ ok: true, pages: msg.pages as string[] });
            else if (msg.reason === 'SOURCE_ENCRYPTED' || msg.reason === 'SOURCE_TOO_LONG') done({ ok: false, reason: msg.reason });
            else done({ ok: false, reason: 'SOURCE_PARSE_FAILED' });
        });
        worker.on('error', () => done({ ok: false, reason: 'SOURCE_PARSE_FAILED' }));
        worker.on('exit', () => done({ ok: false, reason: 'SOURCE_PARSE_FAILED' }));
    });
}
