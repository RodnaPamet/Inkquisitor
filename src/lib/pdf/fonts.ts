/**
 * The PDF's font (issue #24, owner decision 2026-11-19): Noto Sans 2.015,
 * regular and bold, under the SIL Open Font License 1.1 (`fonts/noto-sans/`,
 * with OFL.txt beside the files; credited in NOTICE). It covers Latin, Latin
 * Extended, Greek and Cyrillic; anything else is drawn as `�` by
 * `toPdfText` (./text.ts). The document embeds a SUBSET of each font —
 * PDFKit hands fontkit only the glyphs the document draws — so a PDF carries
 * kilobytes of font, not the 430 KB file.
 *
 * WHERE THE FILES ARE READ FROM. `<cwd>/fonts/noto-sans/`. `next start`, the
 * worker and the test runners all run from the repository root, and the
 * image's processes from `/app`, where the Dockerfile's runner stage copies
 * `fonts/` (tests/unit/pdf/pdf-fonts.test.ts holds both). The files are read
 * once per process and kept as bytes; each document parses its own copy
 * (`registerPdfFonts`), because fontkit caches glyph objects on the font, and
 * a font shared between documents would let one document's text decide
 * another's text layer.
 *
 * Nothing loads PDFKit's standard fonts: the document is created with no
 * default font (`createPdfDocument`), so no Helvetica is read or embedded.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fontkit from 'fontkit';
import { toPdfText } from './text';

/** The directory the font files are read from, relative to the process's working directory. */
export const PDF_FONT_DIR = path.join('fonts', 'noto-sans');

/** The files, by the name a document registers each under. */
export const PDF_FONT_FILES = {
    regular: 'NotoSans-Regular.ttf',
    bold: 'NotoSans-Bold.ttf',
} as const;

/** The names `doc.font(…)` takes. */
export const PDF_FONT = {
    regular: 'Body',
    bold: 'Body-Bold',
} as const;

type Weight = keyof typeof PDF_FONT_FILES;

interface LoadedFonts {
    bytes: Readonly<Record<Weight, Buffer>>;
    /** Code points EVERY weight has a glyph for. */
    coverage: ReadonlySet<number>;
}

let loaded: LoadedFonts | null = null;

function openFont(weight: Weight, bytes: Buffer): fontkit.Font {
    const font = fontkit.create(bytes);
    if (!('hasGlyphForCodePoint' in font)) throw new Error(`The PDF font ${PDF_FONT_FILES[weight]} is a collection, not one font.`);
    return font;
}

/** The fonts' bytes and coverage, read on first use. A missing file throws, naming it. */
function fonts(): LoadedFonts {
    if (loaded) return loaded;
    const dir = path.resolve(process.cwd(), PDF_FONT_DIR);
    const bytes = {} as Record<Weight, Buffer>;
    const sets: Set<number>[] = [];
    for (const weight of Object.keys(PDF_FONT_FILES) as Weight[]) {
        bytes[weight] = fs.readFileSync(path.join(dir, PDF_FONT_FILES[weight]));
        sets.push(new Set(openFont(weight, bytes[weight]).characterSet));
    }
    const coverage = new Set([...sets[0]].filter((cp) => sets.every((set) => set.has(cp))));
    if (!coverage.has(0xfffd)) throw new Error('The PDF font has no replacement character (U+FFFD).');
    loaded = { bytes, coverage };
    return loaded;
}

/** Whether every weight of the PDF font draws `codePoint`. */
export function pdfFontCovers(codePoint: number): boolean {
    return fonts().coverage.has(codePoint);
}

/** `text` as the PDF font can draw it (see ./text.ts). */
export function drawableText(text: string): string {
    return toPdfText(text, pdfFontCovers);
}

/** Register both weights on `doc` (from this document's own parse) and select the regular one. */
export function registerPdfFonts(doc: PDFKit.PDFDocument): void {
    const { bytes } = fonts();
    doc.registerFont(PDF_FONT.regular, bytes.regular);
    doc.registerFont(PDF_FONT.bold, bytes.bold);
    doc.font(PDF_FONT.regular);
}
