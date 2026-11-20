/**
 * A book's bible as one PDF (Phase 1.3), on the lifted PDFKit helpers
 * (src/lib/pdf/): a cover with the book's title, logline and stage, then a
 * section per kind that has entries — the kind's label and description, and
 * every element with its status, summary, filled fields under their template
 * labels and its relations read from its own end. It reads the same
 * `BibleBundle` the Markdown export writes, and words values the same way
 * (`valueLines`): a choice by its option label, a scale by its position, rich
 * text by its text.
 *
 * The PDF is for reading and sharing. It is not imported back; the bundle is
 * the format that round-trips.
 */
import { createPdfDocument, CONTENT_WIDTH, MARGINS, PALETTE } from '@/lib/pdf/pdfKitFactory';
import { addCoverPage, applyHeadersAndFooters, SAFE_BOTTOM_Y } from '@/lib/pdf/layout';
import type { ReportMeta } from '@/lib/pdf/types';
import { drawableText, PDF_FONT } from '@/lib/pdf/fonts';
import { BIBLE_KINDS } from './kinds';
import { getTemplate } from './templates';
import { readingOrder, relationLinesBySlug, sortElements, STATUS_WORDS, valueLines, type BibleBundle } from './bundle-format';

const STAGE_WORDS: Readonly<Record<string, string>> = {
    CONCEPT: 'Concept',
    PLANNING: 'Planning',
    DRAFTING: 'Drafting',
    REVISING: 'Revising',
    PUBLISHING: 'Publishing',
};

export interface BiblePdfMeta {
    workspaceName: string;
    /** ISO timestamp. */
    generatedAt: string;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Keep `needed` points of room below the cursor, or start a new page. */
function room(doc: PDFKit.PDFDocument, needed: number): void {
    if (doc.y + needed > SAFE_BOTTOM_Y) doc.addPage();
}

/**
 * `value` with a line break inserted wherever a run of characters with no
 * space in it would not fit `width` at the document's current font and size.
 *
 * PDFKit splits a word wider than the line itself, but measures what is left
 * of the word again after every line it fills, so one unbroken run costs time
 * in the square of its length: a 100,000-character run (a rich-text value an
 * editor may store) took six seconds to lay out, and every viewer may ask for
 * the PDF. Breaking the run here, measuring each character once, makes it
 * linear; the lines are the ones PDFKit would have made, give or take where
 * the first one starts. The run is cut between user-perceived characters
 * (grapheme clusters), never inside one, so a letter keeps its accents.
 */
export function breakLongRuns(doc: PDFKit.PDFDocument, value: string, width: number): string {
    const widths = new Map<string, number>();
    const widthOf = (ch: string) => {
        let w = widths.get(ch);
        if (w === undefined) widths.set(ch, (w = doc.widthOfString(ch)));
        return w;
    };
    return value.replace(/[^ \t\n]{2,}/g, (run) => {
        if (doc.widthOfString(run) <= width) return run;
        let out = '';
        let line = '';
        let used = 0;
        for (const { segment: ch } of graphemes.segment(run)) {
            const w = widthOf(ch);
            if (line !== '' && used + w > width) {
                out += `${line}\n`;
                line = '';
                used = 0;
            }
            line += ch;
            used += w;
        }
        return out + line;
    });
}

function text(doc: PDFKit.PDFDocument, value: string, options: PDFKit.Mixins.TextOptions = {}): void {
    doc.text(breakLongRuns(doc, drawableText(value), CONTENT_WIDTH), MARGINS.left, doc.y, { width: CONTENT_WIDTH, ...options });
}

export function renderBiblePdf(bundle: BibleBundle, meta: BiblePdfMeta): Promise<Buffer> {
    const report: ReportMeta = {
        workspaceName: meta.workspaceName,
        reportTitle: bundle.book.title,
        reportSubtitle: 'Book bible',
        generatedAt: meta.generatedAt,
    };
    const doc = createPdfDocument(report);
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });

    addCoverPage(doc, report);
    const elements = sortElements(bundle.elements);
    const { book } = bundle;
    doc.font(PDF_FONT.regular).fontSize(11).fillColor(PALETTE.text);
    if (book.logline !== null) text(doc, book.logline, { lineGap: 2 });
    doc.moveDown(0.5);
    const details = [`Stage: ${STAGE_WORDS[book.stage] ?? book.stage}`];
    if (book.genre !== null) details.push(`Genre: ${book.genre}`);
    if (book.audience !== null) details.push(`Audience: ${book.audience}`);
    if (book.targetLength !== null) details.push(`Target length: ${book.targetLength.toLocaleString('en-GB')} words`);
    details.push(elements.length === 0 ? 'No entries yet' : elements.length === 1 ? '1 entry' : `${elements.length} entries`);
    doc.fontSize(9).fillColor(PALETTE.muted);
    for (const d of details) text(doc, d);

    const lines = relationLinesBySlug(elements);
    for (const kind of BIBLE_KINDS) {
        // Plot beats and timeline events in their story order (Phase 3.2).
        const ofKind = readingOrder(elements.filter((e) => e.kind === kind));
        if (ofKind.length === 0) continue;
        const template = getTemplate(kind);
        doc.addPage();
        doc.font(PDF_FONT.bold).fontSize(18).fillColor(PALETTE.accent);
        text(doc, template.label);
        doc.font(PDF_FONT.regular).fontSize(9).fillColor(PALETTE.muted);
        text(doc, template.description, { lineGap: 1 });
        doc.moveDown(1);

        for (const e of ofKind) {
            room(doc, 80);
            doc.font(PDF_FONT.bold).fontSize(14).fillColor(PALETTE.emphasis);
            text(doc, e.customLabel !== null ? `${e.name} (${e.customLabel})` : e.name);
            doc.font(PDF_FONT.regular).fontSize(8).fillColor(PALETTE.subtle);
            text(doc, STATUS_WORDS[e.status]);
            doc.moveDown(0.4);
            if (e.summary !== null) {
                doc.fontSize(10).fillColor(PALETTE.text);
                text(doc, e.summary, { lineGap: 2 });
                doc.moveDown(0.4);
            }
            for (const def of template.fields) {
                const value = e.fields.get(def.key);
                if (value === undefined) continue;
                room(doc, 36);
                doc.font(PDF_FONT.bold).fontSize(8).fillColor(PALETTE.muted);
                text(doc, def.label);
                doc.font(PDF_FONT.regular).fontSize(10).fillColor(PALETTE.text);
                for (const line of valueLines(kind, def.key, value)) text(doc, line, { lineGap: 1 });
                doc.moveDown(0.3);
            }
            const relationLines = lines.get(e.slug) ?? [];
            if (relationLines.length > 0) {
                room(doc, 36);
                doc.font(PDF_FONT.bold).fontSize(8).fillColor(PALETTE.muted);
                text(doc, 'Relations');
                doc.font(PDF_FONT.regular).fontSize(10).fillColor(PALETTE.text);
                for (const r of relationLines) text(doc, `${r.label} ${r.other.name}${r.note !== null ? `: ${r.note.replace(/\s+/g, ' ')}` : ''}`);
            }
            doc.moveDown(0.6);
            doc.moveTo(MARGINS.left, doc.y).lineTo(MARGINS.left + CONTENT_WIDTH, doc.y).strokeColor(PALETTE.rule).lineWidth(0.5).stroke();
            doc.moveDown(0.8);
        }
    }

    applyHeadersAndFooters(doc, report);
    doc.end();
    return done;
}
