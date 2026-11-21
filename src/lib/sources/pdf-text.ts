/**
 * A PDF's text layer, read in a bounded worker thread (Phase 4.0, D26).
 *
 * `scripts/pdf-text-worker.mjs` does the reading; this starts it with a heap
 * limit, hands it a COPY of the bytes, and terminates it when its deadline
 * passes (`SOURCE_PARSE_TIMEOUT`) or when it dies (out of memory, a crash:
 * `SOURCE_PARSE_FAILED`). Nothing here is rendered and no OCR is attempted
 * (D26): a PDF whose pages hold no text is refused `SOURCE_NO_TEXT_LAYER` by
 * the caller, never guessed at.
 */
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface PdfTextLimits {
    timeoutMs: number;
    maxPages: number;
    maxChars: number;
    heapMb: number;
}

export const PDF_TEXT_LIMITS: PdfTextLimits = { timeoutMs: 30_000, maxPages: 3_000, maxChars: 12_000_000, heapMb: 512 };

export type PdfTextResult = { ok: true; pages: string[] } | { ok: false; reason: 'SOURCE_ENCRYPTED' | 'SOURCE_PARSE_FAILED' | 'SOURCE_PARSE_TIMEOUT' | 'SOURCE_TOO_LONG' };

/** Where the worker script is: `<cwd>/scripts`, as the fonts are read from `<cwd>/fonts` (the image copies both). */
export function pdfWorkerPath(cwd: string = process.cwd()): string {
    return path.join(cwd, 'scripts', 'pdf-text-worker.mjs');
}

export function readPdfText(bytes: Uint8Array, limits: PdfTextLimits = PDF_TEXT_LIMITS): Promise<PdfTextResult> {
    return new Promise((resolve) => {
        let settled = false;
        const copy = bytes.slice();
        const worker = new Worker(pdfWorkerPath(), {
            workerData: { bytes: copy, maxPages: limits.maxPages, maxChars: limits.maxChars },
            resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: 64 },
            stdout: true,
            stderr: true,
        });
        // pdf.js warns on stdout/stderr about fonts it skips: never a log line (a warning could quote the document).
        worker.stdout.resume();
        worker.stderr.resume();
        const done = (result: PdfTextResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate();
            resolve(result);
        };
        const timer = setTimeout(() => done({ ok: false, reason: 'SOURCE_PARSE_TIMEOUT' }), limits.timeoutMs);
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
