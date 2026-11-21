/**
 * THE DOCX TEXT WORKER (Phase 4.0, D26): runs mammoth over a DOCX in a worker
 * thread, so a hostile or huge document cannot hold the request's thread or
 * heap. The parent (`src/lib/sources/docx-text.ts`, through
 * `src/lib/sources/parse-worker.ts`) starts it with a memory limit, watches
 * its heap and external memory, and terminates it at its deadline; this file
 * only reads.
 *
 * It is handed a ZIP the parent REBUILT from the entries `readZip` accepted
 * (and refused for any entity declaration), never the upload's own bytes.
 * Images are never read or inlined (an `<img>` with no source). The HTML is
 * returned only when it is within `maxChars`.
 *
 * Plain ESM run by Node itself (never bundled), so it is copied into the image
 * beside `node_modules` (Dockerfile) and read from `<cwd>/scripts`.
 */
import { parentPort, workerData } from 'node:worker_threads';

async function main() {
    const { bytes, maxChars } = workerData;
    const mammoth = (await import('mammoth')).default;
    const noImages = mammoth.images.imgElement(async () => ({ src: '' }));
    let html;
    try {
        const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) }, { convertImage: noImages });
        html = typeof result.value === 'string' ? result.value : '';
    } catch {
        parentPort.postMessage({ ok: false, reason: 'SOURCE_PARSE_FAILED' });
        return;
    }
    if (html.length > maxChars) {
        parentPort.postMessage({ ok: false, reason: 'SOURCE_TOO_LONG' });
        return;
    }
    parentPort.postMessage({ ok: true, html });
}

main().catch(() => parentPort.postMessage({ ok: false, reason: 'SOURCE_PARSE_FAILED' }));
