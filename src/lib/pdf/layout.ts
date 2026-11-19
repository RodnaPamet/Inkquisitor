/**
 * PDF layout helpers (Phase 1.3): the cover page, the running header and
 * footer stamped onto every page after the content is laid out.
 *
 * Adapted from inflect-compliance's `src/lib/pdf/layout.ts` (see
 * docs/carve-manifest.md): the cover, header, footer and
 * `applyHeadersAndFooters` keep inflect's geometry and its fix for the
 * trailing-blank-page bug (`STAMP_TEXT_HEIGHT`, below); the colours are the
 * design tokens (`PALETTE`); the cover names the workspace and the book, with
 * none of inflect's confidentiality or compliance wording; the metadata page
 * and the watermark (compliance reports) are not carried. Text is drawn in
 * the embedded Noto Sans through `drawableText` (./fonts.ts).
 */
import { formatDateShort, formatDateTime } from '@inkquisitor/ui/lib/format-date';
import type { ReportMeta } from './types';
import { CONTENT_WIDTH, MARGINS, PAGE_HEIGHT, PAGE_WIDTH, PALETTE } from './pdfKitFactory';
import { drawableText, PDF_FONT } from './fonts';

// ─── Cover Page ───

export function addCoverPage(doc: PDFKit.PDFDocument, meta: ReportMeta): void {
    // Background band
    doc.rect(0, 0, PAGE_WIDTH, 280).fill(PALETTE.inverted);

    // Workspace name (top-left)
    doc.fontSize(11).fillColor(PALETTE.onInverted).text(drawableText(meta.workspaceName), MARGINS.left, 40, { width: CONTENT_WIDTH });

    // Title
    doc.font(PDF_FONT.bold).fontSize(28).fillColor(PALETTE.onInverted).text(drawableText(meta.reportTitle), MARGINS.left, 100, { width: CONTENT_WIDTH, height: 90, ellipsis: true });
    doc.font(PDF_FONT.regular);

    if (meta.reportSubtitle) {
        doc.fontSize(14).fillColor(PALETTE.onInverted).text(drawableText(meta.reportSubtitle), MARGINS.left, 195, { width: CONTENT_WIDTH, height: 36, ellipsis: true });
    }

    // Generated date, through the canonical formatter (en-GB, UTC), so the
    // document reads the same whichever region the server runs in.
    doc.fontSize(10).fillColor(PALETTE.onInverted).text(`Generated: ${formatDateTime(meta.generatedAt)}`, MARGINS.left, 238);

    // The accent rule
    doc.rect(MARGINS.left, 262, 80, 4).fill(PALETTE.accent);

    // Move cursor past the cover
    doc.y = 320;
}

// ─── Page Header ───

/**
 * Fixed text-cell height (pt) passed to every `text()` call inside the
 * header and footer stamping pass.
 *
 * Why this is load-bearing (inflect's root cause of a trailing-blank-page
 * bug): PDFKit's `text(str, x, y, opts)` auto-paginates if, after writing,
 * the cursor crosses the bottom margin. The footer renders BELOW the bottom
 * margin, so a second write on its line would append a blank page — once per
 * page stamped. `lineBreak: false` only suppresses word-wrap, and
 * `save()`/`restore()` keep the graphics state, not the cursor. Passing
 * `height` makes PDFKit treat the write as bounded and skip the post-write
 * check, so stamping never changes the page count.
 */
const STAMP_TEXT_HEIGHT = 12;

export function addHeader(doc: PDFKit.PDFDocument, meta: ReportMeta): void {
    const y = 20;
    doc.save();

    // Left: workspace name
    doc.fontSize(7).fillColor(PALETTE.subtle).text(drawableText(meta.workspaceName), MARGINS.left, y, { width: 200, lineBreak: false, height: STAMP_TEXT_HEIGHT, ellipsis: true });

    // Centre: title
    doc.text(drawableText(meta.reportTitle), PAGE_WIDTH / 2 - 100, y, { width: 200, lineBreak: false, align: 'center', height: STAMP_TEXT_HEIGHT, ellipsis: true });

    // Right: date (DD/MM/YYYY, UTC)
    doc.text(formatDateShort(meta.generatedAt), PAGE_WIDTH - MARGINS.right - 100, y, { width: 100, align: 'right', lineBreak: false, height: STAMP_TEXT_HEIGHT });

    // Bottom line
    doc.moveTo(MARGINS.left, y + 14).lineTo(PAGE_WIDTH - MARGINS.right, y + 14).strokeColor(PALETTE.rule).lineWidth(0.5).stroke();

    doc.restore();
}

// ─── Page Footer ───

export function addFooter(doc: PDFKit.PDFDocument, pageNum: number, totalPages: number): void {
    const y = PAGE_HEIGHT - 30;
    doc.save();

    // Top line
    doc.moveTo(MARGINS.left, y - 6).lineTo(PAGE_WIDTH - MARGINS.right, y - 6).strokeColor(PALETTE.rule).lineWidth(0.5).stroke();

    // Left: the product. `height` short-circuits auto-pagination (STAMP_TEXT_HEIGHT).
    doc.fontSize(7).fillColor(PALETTE.subtle).text('Inkquisitor', MARGINS.left, y, { lineBreak: false, height: STAMP_TEXT_HEIGHT });

    // Right: page number, the second write on the line.
    doc.text(`Page ${pageNum} of ${totalPages}`, PAGE_WIDTH - MARGINS.right - 80, y, { width: 80, align: 'right', lineBreak: false, height: STAMP_TEXT_HEIGHT });

    doc.restore();
}

// ─── Wire headers and footers to every page ───

/**
 * Stamp the header and footer onto every buffered page but the cover (page
 * index 0, a title page): numbering starts on the first content page, and N
 * is the count of numbered pages. Call once, after every `addPage`.
 */
export function applyHeadersAndFooters(doc: PDFKit.PDFDocument, meta: ReportMeta): void {
    const pages = doc.bufferedPageRange();
    const numberedPageTotal = Math.max(0, pages.count - 1);
    for (let i = pages.start; i < pages.start + pages.count; i++) {
        if (i === pages.start) continue;
        doc.switchToPage(i);
        addHeader(doc, meta);
        addFooter(doc, i - pages.start, numberedPageTotal);
    }
}

// ─── Safe zone: Y beyond which content should start a new page ───

export const SAFE_BOTTOM_Y = PAGE_HEIGHT - MARGINS.bottom - 20;
