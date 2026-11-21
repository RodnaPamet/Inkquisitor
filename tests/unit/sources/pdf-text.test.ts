/**
 * The PDF worker's bounds (Phase 4.0, D26): its heap limit does not bound the
 * typed arrays pdf.js decodes a stream into, so the parent watches the
 * worker's heap AND external memory and stops it past `memoryMb`; and at most
 * `PDF_WORKERS_MAX` workers run in a process at once.
 */
import { _pdfWorkerSlots, PDF_TEXT_LIMITS, PDF_WORKERS_MAX, readPdfText } from '@/lib/sources/pdf-text';
import { makePdf, makePdfStreamBomb } from '../../helpers/source-files';

describe('the PDF worker', () => {
    it('stops a decompression bomb by its memory, not only its heap (a small file inflating far past the bound)', async () => {
        const bomb = makePdfStreamBomb(160);
        expect(bomb.byteLength).toBeLessThan(1024 * 1024);
        const r = await readPdfText(bomb, { ...PDF_TEXT_LIMITS, memoryMb: 48 });
        expect(r).toEqual({ ok: false, reason: 'SOURCE_TOO_LONG' });
    }, 30_000);

    it('runs at most PDF_WORKERS_MAX workers at once; the rest wait their turn and still read', async () => {
        const pdf = await makePdf(['Wren never learned to swim.']);
        let peak = 0;
        const watch = setInterval(() => (peak = Math.max(peak, _pdfWorkerSlots().running)), 5);
        try {
            const results = await Promise.all(Array.from({ length: PDF_WORKERS_MAX + 2 }, () => readPdfText(pdf)));
            expect(results.every((r) => r.ok && r.pages.join(' ').includes('Wren never learned to swim.'))).toBe(true);
        } finally {
            clearInterval(watch);
        }
        expect(peak).toBeLessThanOrEqual(PDF_WORKERS_MAX);
        expect(peak).toBeGreaterThan(0);
        expect(_pdfWorkerSlots()).toEqual({ running: 0, waiting: 0 });
    }, 60_000);

});
