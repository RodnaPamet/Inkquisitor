/**
 * The parse workers' bounds (Phase 4.0, D26): a worker's heap limit does not
 * bound the typed arrays a decoder fills, so the parent watches the worker's
 * heap AND external memory and stops it past `memoryMb`; mammoth never runs
 * on the request's thread; at most `PARSE_WORKERS_MAX` workers run in a
 * process at once; and the image copies every worker script, from the path
 * the code reads it at.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDocxHtml, DOCX_TEXT_LIMITS, docxWorkerPath } from '@/lib/sources/docx-text';
import { parseSource } from '@/lib/sources/parse';
import { _parseWorkerSlots, PARSE_WORKERS_MAX } from '@/lib/sources/parse-worker';
import { PDF_TEXT_LIMITS, pdfWorkerPath, readPdfText } from '@/lib/sources/pdf-text';
import { makeDocx, makePdf, makePdfStreamBomb } from '../../helpers/source-files';

// Mammoth may load only inside the worker (its own module graph, outside Jest's registry): loading it on this thread fails the suite.
jest.mock('mammoth', () => {
    throw new Error('mammoth was loaded on the request’s thread');
});

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('the parse workers', () => {
    it('stop a PDF decompression bomb by its memory, not only its heap (a small file inflating far past the bound)', async () => {
        const bomb = makePdfStreamBomb(160);
        expect(bomb.byteLength).toBeLessThan(1024 * 1024);
        expect(await readPdfText(bomb, { ...PDF_TEXT_LIMITS, memoryMb: 48 })).toEqual({ ok: false, reason: 'SOURCE_TOO_LONG' });
    }, 30_000);

    it('run mammoth in a worker, never on the request’s thread, and stop a heavy DOCX by its memory or its size', async () => {
        const docx = makeDocx(Array.from({ length: 20_000 }, (_, i) => ({ para: `Paragraph ${i} of a long draft about Wren.` })));
        const read = await parseSource(docx, 'long.docx');
        expect(read.blocks).toHaveLength(20_000);
        expect(await readDocxHtml(docx, { ...DOCX_TEXT_LIMITS, memoryMb: 16 })).toEqual({ ok: false, reason: 'SOURCE_TOO_LONG' });
        expect(await readDocxHtml(docx, { ...DOCX_TEXT_LIMITS, maxChars: 1_000 })).toEqual({ ok: false, reason: 'SOURCE_TOO_LONG' });
    }, 60_000);

    it('run at most PARSE_WORKERS_MAX at once; the rest wait their turn and still read', async () => {
        const pdf = await makePdf(['Wren never learned to swim.']);
        let peak = 0;
        const watch = setInterval(() => (peak = Math.max(peak, _parseWorkerSlots().running)), 5);
        try {
            const results = await Promise.all(Array.from({ length: PARSE_WORKERS_MAX + 2 }, () => readPdfText(pdf)));
            expect(results.every((r) => r.ok && r.pages.join(' ').includes('Wren never learned to swim.'))).toBe(true);
        } finally {
            clearInterval(watch);
        }
        expect(peak).toBeLessThanOrEqual(PARSE_WORKERS_MAX);
        expect(peak).toBeGreaterThan(0);
        expect(_parseWorkerSlots()).toEqual({ running: 0, waiting: 0 });
    }, 60_000);

    it('are each copied into the image’s runner stage, at the fixed path the code reads them from', () => {
        const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
        const runner = dockerfile.slice(dockerfile.indexOf('AS runner'));
        expect(runner).toMatch(/^WORKDIR \/app$/m);
        for (const script of [pdfWorkerPath('/app'), docxWorkerPath('/app')]) {
            const relative = path.relative('/app', script);
            expect(fs.existsSync(path.join(REPO_ROOT, relative))).toBe(true);
            expect(runner).toContain(`COPY --from=builder /app/${relative} ./${relative}`);
        }
    });
});
