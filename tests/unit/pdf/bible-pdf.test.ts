/**
 * The bible as a PDF (src/lib/bible/bible-pdf.ts on the lifted helpers in
 * src/lib/pdf/, Phase 1.3): a valid PDF whose text names the book, every
 * kind with entries, every element, its fields under their labels (a choice
 * by its option label), and its relations; in the embedded Noto Sans
 * (issue #24), so Cyrillic, Greek and accented Latin come back out of the
 * text layer exactly, and what the font cannot draw (CJK, emoji) is one `�`
 * per character, never a wrong letter or nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { breakLongRuns, renderBiblePdf } from '@/lib/bible/bible-pdf';
import { createPdfDocument, PALETTE, PALETTE_TOKENS } from '@/lib/pdf/pdfKitFactory';
import { PDF_FONT } from '@/lib/pdf/fonts';
import { REPLACEMENT_CHARACTER } from '@/lib/pdf/text';
import { sampleBundle } from '../../helpers/bible-bundle-fixture';
import { pdfFonts, pdfText, pdfTextRuns } from '../../helpers/pdf-text';
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

    it('prints Cyrillic, Greek and accented Latin exactly, and CJK and emoji as one � per character', async () => {
        const bundle = sampleBundle();
        const bulgarian = 'Щастливата жена на фериботчика — ъгъл, юг, ябълка, ѝ';
        const greek = 'Ωκεανός και θάλασσα: ψυχή, ζωή, ξένος';
        const latin = 'Ålder Łódź Ærøskøbing naïve façade Dvořák ǅ';
        const pdf = await renderBiblePdf(
            {
                ...bundle,
                book: { ...bundle.book, title: 'Солените пътища' },
                elements: [
                    { ...bundle.elements[2], name: bulgarian, summary: `${greek}\n\n${latin}` },
                    { ...bundle.elements[3], name: 'Тайфун 台風 notes 😀 and 👨‍👩‍👧 here' },
                ],
            },
            { ...META, workspaceName: 'Работно място' },
        );
        const runs = pdfTextRuns(pdf);
        for (const exact of [bulgarian, greek, latin, 'Солените пътища', 'Работно място']) expect([exact, runs.includes(exact)]).toEqual([exact, true]);
        // Two CJK characters are two marks; a family emoji (five code points) is one.
        const R = REPLACEMENT_CHARACTER;
        expect(runs).toContain(`Тайфун ${R}${R} notes ${R} and ${R} here (Almanac)`);
        expect(pdfText(pdf)).not.toMatch(/[\u4e00-\u9fff]|\p{Extended_Pictographic}/u);
    });

    it('embeds only subsets of Noto Sans, never a standard font or a whole font file', async () => {
        const pdf = await renderBiblePdf(sampleBundle(), META);
        const fonts = pdfFonts(pdf);
        expect(fonts).toHaveLength(2);
        expect(fonts[0]).toMatch(/^[A-Z]{6}\+NotoSans-Regular$/);
        expect(fonts[1]).toMatch(/^[A-Z]{6}\+NotoSans-Bold$/);
        expect(Buffer.from(pdf).toString('latin1')).not.toContain('Helvetica');
        // Each font file is about 430 KB; the subsets this bible needs are a few.
        expect(pdf.length).toBeLessThan(60_000);
    });

    it('is the same bytes for the same bible', async () => {
        const a = await renderBiblePdf(sampleBundle(), META);
        const b = await renderBiblePdf(sampleBundle(), META);
        expect(Buffer.compare(a, b)).toBe(0);
    });
});

describe('a long unbroken run', () => {
    it('is laid out in linear time, every character kept, no line wider than the page', async () => {
        // A rich-text value may hold 100,000 characters with no space. PDFKit
        // splits such a word itself, but re-measures the rest of it after
        // every line, which took about six seconds for this one run.
        const run = 'abcdefghij'.repeat(10_000);
        const bundle = sampleBundle();
        // Growth, not a wall-clock bound (a 2 s limit flaked under load, 2.H):
        // a run four times as long must cost far less than the sixteen times a
        // quadratic re-measure would. Same machine, same load, median of three.
        const medianMs = async (text: string): Promise<number> => {
            const runs: number[] = [];
            for (let i = 0; i < 3; i += 1) {
                const started = process.hrtime.bigint();
                await renderBiblePdf({ ...bundle, elements: [{ ...bundle.elements[2], summary: text }] }, META);
                runs.push(Number(process.hrtime.bigint() - started) / 1e6);
            }
            return runs.sort((a, b) => a - b)[1];
        };
        const quarter = run.slice(0, run.length / 4);
        await medianMs(quarter); // warm the font and the JIT
        expect((await medianMs(run)) / (await medianMs(quarter))).toBeLessThan(8);
        const pdf = await renderBiblePdf({ ...bundle, elements: [{ ...bundle.elements[2], summary: run }] }, META);
        // Its lines, in drawing order (the page stamps between pages are other runs).
        const lines = pdfTextRuns(pdf).filter((r) => /^[a-j]+$/.test(r));
        expect(lines.length).toBeGreaterThan(100);
        expect(lines.join('')).toBe(run);
    });

    it('breakLongRuns breaks only what does not fit, at the width, and loses nothing', () => {
        const doc = createPdfDocument({ workspaceName: 'w', reportTitle: 't', generatedAt: META.generatedAt });
        doc.font(PDF_FONT.regular).fontSize(10);
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

    it('breakLongRuns never cuts inside a user-perceived character', () => {
        const doc = createPdfDocument({ workspaceName: 'w', reportTitle: 't', generatedAt: META.generatedAt });
        doc.font(PDF_FONT.regular).fontSize(10);
        const cluster = 'e\u0301\u0323'; // e with two combining marks: one character, three code points
        const broken = breakLongRuns(doc, cluster.repeat(200), 100);
        const lines = broken.split('\n');
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) expect(line.length % cluster.length).toBe(0);
        expect(lines.join('')).toBe(cluster.repeat(200));
        doc.end();
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
