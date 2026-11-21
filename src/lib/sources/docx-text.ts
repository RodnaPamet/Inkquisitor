/**
 * A DOCX as HTML, read by mammoth in a bounded worker thread (Phase 4.0, D26).
 *
 * `scripts/docx-text-worker.mjs` runs mammoth (BSD-2-Clause) over the ZIP
 * `parse.ts` REBUILT from what `readZip` accepted, through `parse-worker.ts`
 * (a deadline, a heap limit, the worker's heap and external memory watched,
 * at most two at once): mammoth builds a DOM of each part, which for a large
 * `document.xml` is gigabytes of heap and tens of seconds of work, so it never
 * runs on the request's thread. Images are never read or inlined. Past the
 * deadline: `SOURCE_PARSE_TIMEOUT`; past the memory bound or `maxChars` of
 * HTML: `SOURCE_TOO_LONG`; anything else: `SOURCE_PARSE_FAILED`.
 */
import { parseWorkerPath, runParseWorker, type ParseWorkerLimits } from './parse-worker';

export interface DocxTextLimits extends ParseWorkerLimits {
    /** HTML characters returned at most. */
    maxChars: number;
}

export const DOCX_TEXT_LIMITS: DocxTextLimits = { timeoutMs: 30_000, heapMb: 512, memoryMb: 768, maxChars: 12_000_000 };

export type DocxHtmlResult = { ok: true; html: string } | { ok: false; reason: 'SOURCE_PARSE_FAILED' | 'SOURCE_PARSE_TIMEOUT' | 'SOURCE_TOO_LONG' };

export function docxWorkerPath(cwd: string = process.cwd()): string {
    return parseWorkerPath('docx-text-worker.mjs', cwd);
}

export async function readDocxHtml(zip: Uint8Array, limits: DocxTextLimits = DOCX_TEXT_LIMITS): Promise<DocxHtmlResult> {
    const outcome = await runParseWorker(docxWorkerPath(), { bytes: zip.slice(), maxChars: limits.maxChars }, limits);
    if (outcome.kind === 'TIMEOUT') return { ok: false, reason: 'SOURCE_PARSE_TIMEOUT' };
    if (outcome.kind === 'MEMORY') return { ok: false, reason: 'SOURCE_TOO_LONG' };
    if (outcome.kind === 'FAILED') return { ok: false, reason: 'SOURCE_PARSE_FAILED' };
    const msg = outcome.message as { ok?: unknown; html?: unknown; reason?: unknown } | null;
    if (msg?.ok === true && typeof msg.html === 'string' && msg.html.length <= limits.maxChars) return { ok: true, html: msg.html };
    if (msg?.reason === 'SOURCE_TOO_LONG' || (msg?.ok === true && typeof msg.html === 'string')) return { ok: false, reason: 'SOURCE_TOO_LONG' };
    return { ok: false, reason: 'SOURCE_PARSE_FAILED' };
}
