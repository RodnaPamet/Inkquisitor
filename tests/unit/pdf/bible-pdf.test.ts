/**
 * The bible as a PDF (src/lib/bible/bible-pdf.ts on the lifted helpers in
 * src/lib/pdf/, Phase 1.3): a valid PDF whose text names the book, every
 * kind with entries, every element, its fields under their labels (a choice
 * by its option label), and its relations; with characters the standard
 * fonts cannot draw shown as `?`, never as another letter.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderBiblePdf } from '@/lib/bible/bible-pdf';
import { PALETTE, PALETTE_TOKENS } from '@/lib/pdf/pdfKitFactory';
import { toWinAnsi } from '@/lib/pdf/win-ansi';
import { sampleBundle } from '../../helpers/bible-bundle-fixture';
import { pdfText } from '../../helpers/pdf-text';
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
