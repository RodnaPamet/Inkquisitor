/**
 * The text a PDFKit document draws, for tests (Phase 1.3; issue #24): one
 * string per text operation, in drawing order, page by page. Enough to assert
 * that a PDF names what it should, in the characters it should; not a general
 * PDF parser. It reads what PDFKit writes:
 *
 * - objects through the cross-reference table (`startxref` → `xref`), so no
 *   search ever runs over a stream's binary data;
 * - pages in the order of the page tree's `/Kids`, each page's `/Contents`
 *   stream inflated;
 * - in a content stream, each `/F<n> <size> Tf` (the font in force) and each
 *   `[…] TJ` array, whose hex strings are glyph ids (two bytes each, the
 *   embedded font's Identity-H encoding);
 * - each font's `/ToUnicode` CMap (`beginbfrange` with arrays, the form
 *   PDFKit writes), which maps a glyph id back to the characters it was drawn
 *   for. A font without one (a standard font) is refused: every font the
 *   product draws with is embedded.
 *
 * Every regular expression here is linear: no nested quantifier, and no
 * alternation whose branches can match the same text (CodeQL js/redos).
 */
import { inflateSync } from 'node:zlib';

interface PdfObject {
    /** The object's dictionary, as written (up to `stream` or `endobj`). */
    dict: string;
    /** The stream's bytes, inflated when the dictionary says FlateDecode; null without one. */
    stream: Buffer | null;
}

/** A reference `/Key N 0 R` in a dictionary, as N. */
function refOf(dict: string, key: string): number | null {
    const m = new RegExp(`/${key} (\\d+) 0 R`).exec(dict);
    return m ? Number(m[1]) : null;
}

function readObjects(pdf: Uint8Array): Map<number, PdfObject> {
    const bytes = Buffer.from(pdf);
    const source = bytes.toString('latin1');
    const startxref = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(source.slice(-64));
    if (!startxref) throw new Error('No startxref: not a PDF this helper reads.');
    const xrefAt = Number(startxref[1]);
    const header = /^xref\n0 (\d+)\n/.exec(source.slice(xrefAt, xrefAt + 32));
    if (!header) throw new Error('No cross-reference table at startxref.');
    const count = Number(header[1]);
    const entries = source.slice(xrefAt + header[0].length, xrefAt + header[0].length + count * 20);
    const objects = new Map<number, PdfObject>();
    for (let id = 0; id < count; id++) {
        const entry = /^(\d{10}) \d{5} ([nf])/.exec(entries.slice(id * 20, id * 20 + 20));
        if (!entry || entry[2] !== 'n') continue;
        const at = Number(entry[1]);
        const opening = `${id} 0 obj\n`;
        if (source.slice(at, at + opening.length) !== opening) throw new Error(`Object ${id} is not at its xref offset.`);
        const bodyAt = at + opening.length;
        const endobj = source.indexOf('\nendobj', bodyAt);
        const streamKw = source.indexOf('\nstream\n', bodyAt);
        if (streamKw !== -1 && streamKw < endobj) {
            const dict = source.slice(bodyAt, streamKw);
            const length = /\/Length (\d+)/.exec(dict);
            if (!length) throw new Error(`Stream object ${id} has no direct /Length.`);
            const dataAt = streamKw + '\nstream\n'.length;
            const raw = bytes.subarray(dataAt, dataAt + Number(length[1]));
            objects.set(id, { dict, stream: dict.includes('/FlateDecode') ? inflateSync(raw) : Buffer.from(raw) });
        } else {
            objects.set(id, { dict: source.slice(bodyAt, endobj), stream: null });
        }
    }
    return objects;
}

/** A ToUnicode CMap as glyph id → the characters it stands for. */
function readToUnicode(cmap: string): Map<number, string> {
    if (cmap.includes('beginbfchar')) throw new Error('A ToUnicode CMap with bfchar entries: not what PDFKit writes.');
    const map = new Map<number, string>();
    const start = cmap.indexOf('beginbfrange');
    const end = cmap.indexOf('endbfrange');
    if (start === -1 || end === -1) throw new Error('A ToUnicode CMap with no bfrange.');
    const ranges = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g;
    const body = cmap.slice(start, end);
    for (let r = ranges.exec(body); r; r = ranges.exec(body)) {
        let code = parseInt(r[1], 16);
        for (const dst of r[3].matchAll(/<([0-9a-fA-F ]*)>/g)) {
            const units = dst[1].split(' ').filter((u) => u !== '').map((u) => parseInt(u, 16));
            map.set(code++, String.fromCharCode(...units));
        }
    }
    return map;
}

/** Every font the document's resources name: `F1` → its ToUnicode map and base font. */
function readFonts(objects: Map<number, PdfObject>): Map<string, { baseFont: string; toUnicode: Map<number, string> | null }> {
    const fonts = new Map<string, { baseFont: string; toUnicode: Map<number, string> | null }>();
    for (const { dict } of objects.values()) {
        const block = /\/Font <<([^>]*)>>/.exec(dict);
        if (!block) continue;
        for (const ref of block[1].matchAll(/\/([A-Za-z0-9]+) (\d+) 0 R/g)) {
            const font = objects.get(Number(ref[2]));
            if (!font) throw new Error(`Font ${ref[1]} names a missing object.`);
            const baseFont = /\/BaseFont \/([^\s/<>[\]]+)/.exec(font.dict)?.[1] ?? '';
            const cmapRef = refOf(font.dict, 'ToUnicode');
            const cmap = cmapRef === null ? null : objects.get(cmapRef)?.stream;
            fonts.set(ref[1], { baseFont, toUnicode: cmap ? readToUnicode(cmap.toString('latin1')) : null });
        }
    }
    return fonts;
}

/** The base font of every font a page uses (`ABCDEF+NotoSans-Regular` for an embedded subset). */
export function pdfFonts(pdf: Uint8Array): string[] {
    return [...readFonts(readObjects(pdf)).values()].map((f) => f.baseFont).sort();
}

/** The page objects in reading order. */
function pagesInOrder(objects: Map<number, PdfObject>): PdfObject[] {
    const root = [...objects.values()].find((o) => /\/Type \/Pages\b/.test(o.dict) && !o.dict.includes('/Parent'));
    if (!root) throw new Error('No page tree.');
    const kids = /\/Kids \[([^\]]*)\]/.exec(root.dict)?.[1] ?? '';
    return [...kids.matchAll(/(\d+) 0 R/g)].map((k) => {
        const page = objects.get(Number(k[1]));
        if (!page || !page.dict.includes('/Type /Page')) throw new Error(`Page ${k[1]} is missing or nested (not what PDFKit writes).`);
        return page;
    });
}

export function pdfTextRuns(pdf: Uint8Array): string[] {
    const objects = readObjects(pdf);
    const fonts = readFonts(objects);
    const runs: string[] = [];
    for (const page of pagesInOrder(objects)) {
        const contentsRef = refOf(page.dict, 'Contents');
        const content = contentsRef === null ? null : objects.get(contentsRef)?.stream;
        if (!content) continue;
        const ops = content.toString('latin1');
        let font: { baseFont: string; toUnicode: Map<number, string> | null } | undefined;
        // One branch starts with `/`, the other with `[`: they never overlap.
        // A TJ array's hex strings never contain `]`, so one class reads it.
        const tokens = /\/([A-Za-z0-9]+) [0-9.]+ Tf|\[([^\]]*)\] TJ/g;
        for (let t = tokens.exec(ops); t; t = tokens.exec(ops)) {
            if (t[1] !== undefined) {
                font = fonts.get(t[1]);
                if (!font) throw new Error(`The content selects /${t[1]}, which no resource names.`);
                continue;
            }
            if (!font) throw new Error('A TJ before any Tf.');
            if (!font.toUnicode) throw new Error(`The font ${font.baseFont} has no ToUnicode map: not embedded.`);
            const toUnicode = font.toUnicode;
            let run = '';
            for (const hex of t[2].matchAll(/<([0-9a-fA-F]*)>/g)) {
                for (let i = 0; i + 3 < hex[1].length; i += 4) {
                    const glyph = parseInt(hex[1].slice(i, i + 4), 16);
                    const chars = toUnicode.get(glyph);
                    if (chars === undefined) throw new Error(`Glyph ${glyph} of ${font.baseFont} has no ToUnicode entry.`);
                    run += chars;
                }
            }
            runs.push(run);
        }
    }
    return runs;
}

/** Every text run joined with newlines. */
export function pdfText(pdf: Uint8Array): string {
    return pdfTextRuns(pdf).join('\n');
}
