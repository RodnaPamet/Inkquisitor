/**
 * The bible as a PDF (src/lib/bible/bible-pdf.ts on the lifted helpers in
 * src/lib/pdf/, Phase 1.3): a valid PDF whose text names the book, every
 * kind with entries, every element, its fields under their labels (a choice
 * by its option label), and its relations; with characters the standard
 * fonts cannot draw shown as `?`, never as another letter.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { breakLongRuns, renderBiblePdf } from '@/lib/bible/bible-pdf';
import { createPdfDocument, PALETTE, PALETTE_TOKENS } from '@/lib/pdf/pdfKitFactory';
import { toWinAnsi } from '@/lib/pdf/win-ansi';
import { sampleBundle } from '../../helpers/bible-bundle-fixture';
import { pdfText, pdfTextRuns } from '../../helpers/pdf-text';
import { REPO_ROOT } from '../../helpers/repo-files';

const META = { workspaceName: 'Mara’s desk', generatedAt: '2026-11-19T10:00:00.000Z' };

describe('renderBiblePdf', () => {
    it('is a PDF naming the book, each kind with entries, every element, its fields and relations', async () => {
        const pdf = await renderBiblePdf(sampleBundle(), META);
        const head = Buffer.from(pdf.subarray(0, 8)).toString('latin1');
        expect(head.startsWith('%PDF-1.')).toBe(true);
        expect(Buffer.from(pdf.subarray(-6)).toString('latin1')).toContain('%%EOF');
        const text = pdfText(pdf);
        for (const expected of [
            'The Salt Roads',
            'Mara’s desk',
            'Character',
            'Faction',
            'Custom element',
            'Mara Vell',
            'Tam Vell',
            'The Salt Guild',
            'Tide tables (Almanac)',
            'Speaking voice',
            'Carries the book', // the choice's option label, not its value
            'Short clipped sentences & no small talk.',
            'member of The Salt Guild: Reluctantly',
            'has member Mara Vell: Reluctantly',
            'Page 1 of',
        ]) {
            expect([expected, text.includes(expected)]).toEqual([expected, true]);
        }
        expect(text).not.toContain('carries_book');
    });

    it('prints an empty bible as a cover that says so, not as nothing', async () => {
        const text = pdfText(await renderBiblePdf({ ...sampleBundle(), elements: [] }, META));
        expect(text).toContain('No entries yet');
    });

    it('shows a character the standard fonts cannot draw as ?, never another letter', async () => {
        const bundle = sampleBundle();
        const pdf = await renderBiblePdf({ ...bundle, elements: [{ ...bundle.elements[2], name: 'Ωmega Ålder' }] }, META);
        expect(pdfText(pdf)).toContain('?mega Ålder');
    });
});

describe('a long unbroken run', () => {
    it('is laid out in linear time, every character kept, no line wider than the page', async () => {
        // A rich-text value may hold 100,000 characters with no space. PDFKit
        // splits such a word itself, but re-measures the rest of it after
        // every line, which took about six seconds for this one run.
        const run = 'abcdefghij'.repeat(10_000);
        const bundle = sampleBundle();
        const started = Date.now();
        const pdf = await renderBiblePdf({ ...bundle, elements: [{ ...bundle.elements[2], summary: run }] }, META);
        expect(Date.now() - started).toBeLessThan(2_000);
        // Its lines, in drawing order (the page stamps between pages are other runs).
        const lines = pdfTextRuns(pdf).filter((r) => /^[a-j]+$/.test(r));
        expect(lines.length).toBeGreaterThan(100);
        expect(lines.join('')).toBe(run);
    });

    it('breakLongRuns breaks only what does not fit, at the width, and loses nothing', () => {
        const doc = createPdfDocument({ workspaceName: 'w', reportTitle: 't', generatedAt: META.generatedAt });
        doc.font('Helvetica').fontSize(10);
        const width = 200;
        const long = 'W'.repeat(300);
        const broken = breakLongRuns(doc, `short words stay ${long} as they are`, width);
        expect(broken.startsWith('short words stay ')).toBe(true);
        expect(broken.endsWith(' as they are')).toBe(true);
        const pieces = broken.slice('short words stay '.length, -' as they are'.length).split('\n');
        expect(pieces.join('')).toBe(long);
        expect(pieces.length).toBeGreaterThan(1);
        for (const piece of pieces) expect(doc.widthOfString(piece)).toBeLessThanOrEqual(width);
        // A full line is full: one more character would not have fitted.
        expect(doc.widthOfString(`${pieces[0]}W`)).toBeGreaterThan(width);
        expect(breakLongRuns(doc, 'nothing here is long', width)).toBe('nothing here is long');
        doc.end();
    });
});

describe('toWinAnsi', () => {
    it('keeps Latin-1 and the WinAnsi punctuation, composes accents, and replaces the rest', () => {
        expect(toWinAnsi('café — “quoted” … €5')).toBe('café — “quoted” … €5');
        expect(toWinAnsi('é')).toBe('é');
        expect(toWinAnsi('Ж中😀')).toBe('???');
        expect(toWinAnsi('a\u0000b\tc\nd\u0085')).toBe('ab\tc\nd');
    });
});

describe('the PDF palette', () => {
    it('is the light theme’s design tokens, value for value', () => {
        const css = fs.readFileSync(path.join(REPO_ROOT, 'src/styles/tokens.css'), 'utf8');
        const start = /^\[data-theme="light"\]\s*\{/m.exec(css);
        expect(start).not.toBeNull();
        const light = css.slice(start!.index);
        const block = light.slice(0, light.indexOf('}'));
        for (const [name, token] of Object.entries(PALETTE_TOKENS)) {
            const m = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(block);
            expect([name, m?.[1].toUpperCase()]).toEqual([name, PALETTE[name as keyof typeof PALETTE].toUpperCase()]);
        }
    });
});
