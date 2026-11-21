/**
 * THE PDF TEXT WORKER (Phase 4.0, D26): reads a PDF's text layer in a worker
 * thread, so a hostile or huge PDF cannot hold the request's thread or heap.
 * The parent (`src/lib/sources/pdf-text.ts`) starts it with a memory limit
 * (`resourceLimits`) and terminates it at its deadline; this file only reads.
 *
 * pdf.js is loaded through `unpdf` (MIT; its serverless build of pdf.js,
 * Apache-2.0), with `isEvalSupported: false` (no font program is ever
 * compiled to JavaScript) and no worker of its own. Nothing is rendered: only
 * each page's text content is read, page by page, stopping at `maxPages` and
 * at `maxChars` characters.
 *
 * Plain ESM run by Node itself (never bundled), so it is copied into the image
 * beside `node_modules` (Dockerfile) and read from `<cwd>/scripts`.
 */
import { parentPort, workerData } from 'node:worker_threads';

async function main() {
    const { bytes, maxPages, maxChars } = workerData;
    const { getDocumentProxy } = await import('unpdf');
    let pdf;
    try {
        pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false });
    } catch (err) {
        const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
        parentPort.postMessage({ ok: false, reason: name === 'PasswordException' ? 'SOURCE_ENCRYPTED' : 'SOURCE_PARSE_FAILED' });
        return;
    }
    if (pdf.numPages > maxPages) {
        parentPort.postMessage({ ok: false, reason: 'SOURCE_TOO_LONG' });
        return;
    }
    const pages = [];
    let chars = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const lines = [];
        let line = '';
        for (const item of content.items) {
            if (typeof item.str !== 'string') continue;
            line += item.str;
            if (item.hasEOL) {
                lines.push(line);
                line = '';
            }
        }
        if (line !== '') lines.push(line);
        const text = lines.join('\n');
        chars += text.length;
        if (chars > maxChars) {
            parentPort.postMessage({ ok: false, reason: 'SOURCE_TOO_LONG' });
            return;
        }
        pages.push(text);
        page.cleanup();
    }
    if (typeof pdf.destroy === 'function') await pdf.destroy();
    parentPort.postMessage({ ok: true, pages });
}

main().catch(() => parentPort.postMessage({ ok: false, reason: 'SOURCE_PARSE_FAILED' }));
