/**
 * A PDF's text layer, read in a bounded worker thread (Phase 4.0, D26).
 *
 * `scripts/pdf-text-worker.mjs` does the reading, through `parse-worker.ts`
 * (a deadline, a heap limit, the worker's heap and external memory watched,
 * at most two at once). It is handed a COPY of the bytes. Past the deadline:
 * `SOURCE_PARSE_TIMEOUT`; past the memory bound (a stream that inflates to
 * gigabytes): `SOURCE_TOO_LONG`; a crash: `SOURCE_PARSE_FAILED`. Nothing here
 * is rendered and no OCR is attempted (D26): a PDF whose pages hold no text is
 * refused `SOURCE_NO_TEXT_LAYER` by the caller, never guessed at.
 */
import { parseWorkerPath, runParseWorker, type ParseWorkerLimits } from './parse-worker';

export interface PdfTextLimits extends ParseWorkerLimits {
    maxPages: number;
    maxChars: number;
}

export const PDF_TEXT_LIMITS: PdfTextLimits = { timeoutMs: 30_000, maxPages: 3_000, maxChars: 12_000_000, heapMb: 512, memoryMb: 768 };

export type PdfTextResult = { ok: true; pages: string[] } | { ok: false; reason: 'SOURCE_ENCRYPTED' | 'SOURCE_PARSE_FAILED' | 'SOURCE_PARSE_TIMEOUT' | 'SOURCE_TOO_LONG' };

/** Where the worker script is: `<cwd>/scripts`, as the fonts are read from `<cwd>/fonts` (the image copies both). */
export function pdfWorkerPath(cwd: string = process.cwd()): string {
    return parseWorkerPath('pdf-text-worker.mjs', cwd);
}

export async function readPdfText(bytes: Uint8Array, limits: PdfTextLimits = PDF_TEXT_LIMITS): Promise<PdfTextResult> {
    const outcome = await runParseWorker(pdfWorkerPath(), { bytes: bytes.slice(), maxPages: limits.maxPages, maxChars: limits.maxChars }, limits);
    if (outcome.kind === 'TIMEOUT') return { ok: false, reason: 'SOURCE_PARSE_TIMEOUT' };
    if (outcome.kind === 'MEMORY') return { ok: false, reason: 'SOURCE_TOO_LONG' };
    if (outcome.kind === 'FAILED') return { ok: false, reason: 'SOURCE_PARSE_FAILED' };
    const msg = outcome.message as { ok?: unknown; pages?: unknown; reason?: unknown } | null;
    if (msg?.ok === true && Array.isArray(msg.pages) && msg.pages.every((p) => typeof p === 'string')) return { ok: true, pages: msg.pages as string[] };
    if (msg?.reason === 'SOURCE_ENCRYPTED' || msg?.reason === 'SOURCE_TOO_LONG') return { ok: false, reason: msg.reason };
    return { ok: false, reason: 'SOURCE_PARSE_FAILED' };
}
