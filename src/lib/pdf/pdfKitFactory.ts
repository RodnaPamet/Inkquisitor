/**
 * PDFKit document factory (Phase 1.3): A4 portrait documents with one set of
 * margins, metadata and the product's palette.
 *
 * Adapted from inflect-compliance's `src/lib/pdf/pdfKitFactory.ts` (see
 * docs/carve-manifest.md): the margins, page size and buffered pages are
 * inflect's; the brand colours are replaced by Inkquisitor's design tokens
 * (`PALETTE`, each the LIGHT theme's value of the token it names in
 * src/styles/tokens.css — paper is light — held equal to it by
 * tests/unit/pdf/pdf-palette.test.ts); the metadata names the workspace and
 * Inkquisitor.
 *
 * Fonts: Noto Sans, embedded and subset (./fonts.ts; issue #24). The document
 * is created with NO default font, so PDFKit's standard Helvetica is never
 * read or embedded, and both Noto Sans weights are registered on it before
 * anything is drawn. Text is passed through `drawableText` first.
 * `pdfkit` (and `fontkit`) are server external packages (next.config.mjs).
 */
import PDFDocument from 'pdfkit';
import { registerPdfFonts } from './fonts';
import type { ReportMeta } from './types';

// ─── Palette (light-theme design tokens) ───

export const PALETTE = {
    /** --content-emphasis: headings */
    emphasis: '#14110D',
    /** --content-default: body text */
    text: '#2A251F',
    /** --content-muted: captions, labels */
    muted: '#554C40',
    /** --content-subtle: page furniture */
    subtle: '#685E50',
    /** --brand-default: the violet-ink accent */
    accent: '#5B3A8C',
    /** --border-default: rules */
    rule: '#D8CCB5',
    /** --bg-inverted: the cover band (ink) */
    inverted: '#1A1612',
    /** --content-inverted: text on the band (parchment) */
    onInverted: '#FBF7EE',
} as const;

/** The token each palette entry mirrors (the palette test reads them from tokens.css). */
export const PALETTE_TOKENS: Readonly<Record<keyof typeof PALETTE, string>> = {
    emphasis: '--content-emphasis',
    text: '--content-default',
    muted: '--content-muted',
    subtle: '--content-subtle',
    accent: '--brand-default',
    rule: '--border-default',
    inverted: '--bg-inverted',
    onInverted: '--content-inverted',
};

// ─── Margins ───

export const MARGINS = {
    top: 60,
    bottom: 50,
    left: 50,
    right: 50,
} as const;

export const PAGE_WIDTH = 595.28; // A4 portrait width (pt)
export const PAGE_HEIGHT = 841.89; // A4 portrait height (pt)
export const CONTENT_WIDTH = PAGE_WIDTH - MARGINS.left - MARGINS.right;

/** A new PDFKit document with the defaults, its fonts registered and the regular one selected. */
export function createPdfDocument(meta: ReportMeta): PDFKit.PDFDocument {
    const doc = new PDFDocument({
        // No default font: PDFKit would otherwise load Helvetica (an empty
        // string is the one value its constructor skips loading for).
        font: '',
        size: 'A4',
        margins: { ...MARGINS },
        bufferPages: true, // enables page counting for footers
        info: {
            Title: meta.reportTitle,
            Author: meta.workspaceName,
            Subject: meta.reportSubtitle || meta.reportTitle,
            Creator: 'Inkquisitor',
            Producer: 'PDFKit',
            CreationDate: new Date(meta.generatedAt),
        },
    });
    registerPdfFonts(doc);
    return doc;
}
