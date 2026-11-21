/**
 * READING AN UPLOAD (Phase 4.0, D26): what it is, and its text as blocks.
 *
 * THE FORMAT IS SNIFFED FROM THE BYTES, the file name only telling Markdown
 * from plain text (both are text). In this order, so no text and no archive
 * that merely MENTIONS `%PDF-` near its start is handed to the PDF reader:
 *
 *   a ZIP's magic at byte 0        a DOCX or an EPUB (below), or `SOURCE_TYPE`
 *   `%PDF-` at byte 0              PDF
 *   valid UTF-8 with no NUL        Markdown (`.md`, `.markdown`) or plain text
 *   `%PDF-` in the first KiB of    PDF (a header behind a few bytes of junk, as
 *   bytes that are not text        readers accept)
 *
 *   PDF                            its text layer, in a bounded worker
 *                                  thread (`pdf-text.ts`). No text layer is
 *                                  refused `SOURCE_NO_TEXT_LAYER` (no OCR, D26).
 *   a ZIP holding `word/document.xml`  DOCX: through mammoth (BSD-2-Clause), as
 *                                  inflect-compliance reads Word.
 *   a ZIP whose `mimetype` is `application/epub+zip`   EPUB: the OPF's spine,
 *                                  each XHTML document through the HTML block
 *                                  reader, a chapter break between documents.
 *
 * Anything else is refused `SOURCE_TYPE`.
 *
 * BOUNDS. A ZIP is read ONLY through `readZip` (counts, sizes, ratio, names,
 * the local header against the central directory: a zip bomb is refused
 * `SOURCE_ARCHIVE_REFUSED`). EVERY entry of a DOCX or an EPUB — whatever its
 * name, since mammoth follows the package's relationships to a part of any
 * name — is refused when it declares an entity (`<!ENTITY`, a parameter entity
 * included: entity expansion is how a small XML file becomes a huge one), in
 * UTF-8 or UTF-16, `SOURCE_XML_REFUSED`; a DOCX entry whose DOCTYPE has an
 * internal subset or names an external DTD (no Word part has either) is
 * refused the same. Mammoth is handed a ZIP REBUILT from the entries `readZip`
 * accepted, so it reads nothing that was not checked, and it never inlines an
 * image (a photo is not text, and as a data URI it would count against the
 * text bound). The PDF worker has a heap limit and a deadline; the other
 * readers are bounded by their input, which these limits bound. A text past
 * `SOURCE_TEXT_MAX_CHARS` is refused `SOURCE_TOO_LONG`.
 */
import mammoth from 'mammoth';
import { Parser } from 'htmlparser2';
import { readZip, writeZip, ZipRefusal, type ZipLimits } from '@/lib/archive/zip';
import { blocksFromHtml, blocksFromMarkdown, blocksFromPlainText, type DocBlock } from './document';
import { readPdfText, type PdfTextResult } from './pdf-text';
import { SOURCE_TEXT_MAX_CHARS, type SourceFormat, type SourceRefusalReason } from './vocabulary';

export class SourceRefusal extends Error {
    constructor(
        readonly reason: SourceRefusalReason,
        /** A sub-reason the reason carries (the ZIP refusal's code), never text from the file. */
        readonly detail?: string,
    ) {
        super(`source refused: ${reason}`);
        this.name = 'SourceRefusal';
    }
}

/** The ZIP bounds a DOCX or an EPUB is read under. */
export const SOURCE_ZIP_LIMITS: ZipLimits = { maxEntries: 4_000, maxEntryBytes: 48 * 1024 * 1024, maxTotalBytes: 96 * 1024 * 1024, maxRatio: 60 };

/** EPUB spine documents read at most. */
export const EPUB_SPINE_MAX = 2_000;

export interface ParsedSource {
    format: SourceFormat;
    blocks: DocBlock[];
}

export interface ParseDeps {
    /** The PDF reader (tests: a fake; omitted: the bounded worker). */
    readPdf?: (bytes: Uint8Array) => Promise<PdfTextResult>;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
    return magic.every((b, i) => bytes[i] === b);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** `%PDF-` somewhere in the first KiB (a header behind junk): asked only of bytes that are neither a ZIP nor text. */
function hasPdfHeaderNearStart(bytes: Uint8Array): boolean {
    const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024)).toString('latin1');
    return head.includes('%PDF-');
}

function decodeUtf8(bytes: Uint8Array): string | null {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return text.includes('\u0000') ? null : text.replace(/^﻿/, '');
    } catch {
        return null;
    }
}

function textOfEntry(entries: ReadonlyMap<string, Uint8Array>, name: string): string | null {
    const raw = entries.get(name);
    return raw ? decodeUtf8(raw) : null;
}

/** How far past `<!DOCTYPE` its declaration is read for an internal subset or an external identifier. */
const DOCTYPE_WINDOW = 1_024;

/** A DOCTYPE with an internal subset (`[`) or an external DTD (`SYSTEM` / `PUBLIC`); `<!DOCTYPE html>` alone is neither. Scanned with indexOf, never a backtracking pattern. */
function declaresDtd(lower: string): boolean {
    for (let at = lower.indexOf('<!doctype'); at >= 0; at = lower.indexOf('<!doctype', at + 1)) {
        const window = lower.slice(at + 9, at + 9 + DOCTYPE_WINDOW);
        const end = window.indexOf('>');
        const decl = end >= 0 ? window.slice(0, end) : window;
        if (decl.includes('[') || /\b(?:system|public)\b/.test(decl)) return true;
    }
    return false;
}

/**
 * Refuse an archive any entry of which declares an XML entity (or, with `dtd`, carries a DOCTYPE with an
 * internal subset or an external DTD). Every entry, whatever its name: a reader that follows the package's
 * relationships parses a part of any name as XML.
 */
function assertNoEntityDeclarations(entries: ReadonlyMap<string, Uint8Array>, refuse: { dtd: boolean }): void {
    for (const data of entries.values()) {
        // Latin-1 keeps every byte one character, so the marker is found whatever the encoding claims;
        // without its NULs, a UTF-16 document's ASCII markup reads as ASCII too.
        const latin1 = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1').toLowerCase();
        for (const text of latin1.includes('\u0000') ? [latin1, latin1.replace(/\u0000/g, '')] : [latin1]) {
            if (text.includes('<!entity') || (refuse.dtd && declaresDtd(text))) throw new SourceRefusal('SOURCE_XML_REFUSED');
        }
    }
}

function assertTextBound(text: string): void {
    if (text.length > SOURCE_TEXT_MAX_CHARS) throw new SourceRefusal('SOURCE_TOO_LONG');
}

function readZipOrRefuse(bytes: Uint8Array): Map<string, Uint8Array> {
    try {
        return readZip(bytes, SOURCE_ZIP_LIMITS);
    } catch (err) {
        if (err instanceof ZipRefusal) throw new SourceRefusal('SOURCE_ARCHIVE_REFUSED', err.reason);
        throw err;
    }
}

/** An XML document's elements, read with htmlparser2 in XML mode: (name, attributes) in document order. */
function xmlElements(xml: string): Array<{ name: string; attrs: Record<string, string> }> {
    const out: Array<{ name: string; attrs: Record<string, string> }> = [];
    const parser = new Parser({ onopentag: (name, attrs) => out.push({ name: name.toLowerCase(), attrs }) }, { xmlMode: true, decodeEntities: true });
    parser.parseComplete(xml);
    return out;
}

/** A path inside the archive, resolved against a directory (no escape above the root). */
export function resolveZipPath(dir: string, href: string): string | null {
    const clean = decodeURIComponentSafe(href.split('#')[0]);
    if (clean === null || clean === '' || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
    const segments = dir === '' ? [] : dir.split('/');
    for (const seg of clean.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (segments.length === 0) return null;
            segments.pop();
        } else segments.push(seg);
    }
    return segments.join('/');
}

function decodeURIComponentSafe(s: string): string | null {
    try {
        return decodeURIComponent(s);
    } catch {
        return null;
    }
}

/** Mammoth never reads or inlines an image: an `<img>` with no source, which the block reader ignores. */
const NO_IMAGES = mammoth.images.imgElement(async () => ({ src: '' }));

async function parseDocx(entries: Map<string, Uint8Array>): Promise<DocBlock[]> {
    assertNoEntityDeclarations(entries, { dtd: true });
    const rebuilt = writeZip(entries);
    let html: string;
    try {
        const result = await mammoth.convertToHtml({ buffer: Buffer.from(rebuilt.buffer, rebuilt.byteOffset, rebuilt.byteLength) }, { convertImage: NO_IMAGES });
        html = result.value ?? '';
    } catch {
        throw new SourceRefusal('SOURCE_PARSE_FAILED');
    }
    assertTextBound(html);
    return blocksFromHtml(html);
}

function parseEpub(entries: Map<string, Uint8Array>): DocBlock[] {
    // An EPUB 2 document carries the XHTML DOCTYPE as a matter of course; its markup is read by htmlparser2, which never fetches or expands one.
    assertNoEntityDeclarations(entries, { dtd: false });
    const container = textOfEntry(entries, 'META-INF/container.xml');
    if (container === null) throw new SourceRefusal('SOURCE_PARSE_FAILED');
    const rootfile = xmlElements(container).find((e) => e.name === 'rootfile' && typeof e.attrs['full-path'] === 'string');
    const opfPath = rootfile ? resolveZipPath('', rootfile.attrs['full-path']) : null;
    const opf = opfPath ? textOfEntry(entries, opfPath) : null;
    if (opf === null || opfPath === null) throw new SourceRefusal('SOURCE_PARSE_FAILED');
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const elements = xmlElements(opf);
    const manifest = new Map<string, { href: string; type: string }>();
    for (const e of elements) {
        if (e.name === 'item' && e.attrs.id && e.attrs.href) manifest.set(e.attrs.id, { href: e.attrs.href, type: (e.attrs['media-type'] ?? '').toLowerCase() });
    }
    const spine = elements.filter((e) => e.name === 'itemref' && e.attrs.idref).map((e) => e.attrs.idref);
    if (spine.length === 0 || spine.length > EPUB_SPINE_MAX) throw new SourceRefusal(spine.length === 0 ? 'SOURCE_PARSE_FAILED' : 'SOURCE_TOO_LONG');
    const blocks: DocBlock[] = [];
    let chars = 0;
    for (const idref of spine) {
        const item = manifest.get(idref);
        if (!item || !(item.type.includes('html') || /\.x?html?$/i.test(item.href))) continue;
        const path = resolveZipPath(opfDir, item.href);
        const xhtml = path ? textOfEntry(entries, path) : null;
        if (xhtml === null) continue;
        chars += xhtml.length;
        if (chars > SOURCE_TEXT_MAX_CHARS * 2) throw new SourceRefusal('SOURCE_TOO_LONG');
        const doc = blocksFromHtml(xhtml);
        if (doc.length === 0) continue;
        if (blocks.length > 0) blocks.push({ kind: 'break', strength: 'chapter' });
        blocks.push(...doc);
    }
    return blocks;
}

async function parsePdf(bytes: Uint8Array, deps: ParseDeps): Promise<DocBlock[]> {
    const result = await (deps.readPdf ?? readPdfText)(bytes);
    if (!result.ok) throw new SourceRefusal(result.reason);
    const visible = result.pages.reduce((n, p) => n + p.replace(/\s/g, '').length, 0);
    // No OCR (D26): a scanned PDF's pages are images, and their text layer is empty.
    if (visible < 10) throw new SourceRefusal('SOURCE_NO_TEXT_LAYER');
    const blocks: DocBlock[] = [];
    for (const page of result.pages) blocks.push(...blocksFromPlainText(page));
    return blocks;
}

/** What the upload is (sniffed from its bytes; the name tells Markdown from text). Throws `SourceRefusal`. */
export function sniffFormat(bytes: Uint8Array, filename: string): { format: SourceFormat; entries?: Map<string, Uint8Array>; text?: string } {
    if (bytes.byteLength === 0) throw new SourceRefusal('SOURCE_EMPTY');
    if (startsWith(bytes, ZIP_MAGIC)) {
        const entries = readZipOrRefuse(bytes);
        const mimetype = textOfEntry(entries, 'mimetype');
        if (mimetype !== null && mimetype.trim() === 'application/epub+zip') return { format: 'EPUB', entries };
        if (entries.has('word/document.xml') && entries.has('[Content_Types].xml')) return { format: 'DOCX', entries };
        throw new SourceRefusal('SOURCE_TYPE');
    }
    if (startsWith(bytes, PDF_MAGIC)) return { format: 'PDF' };
    const text = decodeUtf8(bytes);
    if (text !== null) return { format: /\.(?:md|markdown)$/i.test(filename.trim()) ? 'MARKDOWN' : 'TXT', text };
    if (hasPdfHeaderNearStart(bytes)) return { format: 'PDF' };
    throw new SourceRefusal('SOURCE_TYPE');
}

/** Read an upload into blocks. Throws `SourceRefusal` (the reasons in the header). */
export async function parseSource(bytes: Uint8Array, filename: string, deps: ParseDeps = {}): Promise<ParsedSource> {
    const sniffed = sniffFormat(bytes, filename);
    let blocks: DocBlock[];
    switch (sniffed.format) {
        case 'PDF':
            blocks = await parsePdf(bytes, deps);
            break;
        case 'DOCX':
            blocks = await parseDocx(sniffed.entries!);
            break;
        case 'EPUB':
            blocks = parseEpub(sniffed.entries!);
            break;
        case 'MARKDOWN':
            assertTextBound(sniffed.text!);
            blocks = blocksFromMarkdown(sniffed.text!);
            break;
        default:
            assertTextBound(sniffed.text!);
            blocks = blocksFromPlainText(sniffed.text!);
    }
    const chars = blocks.reduce((n, b) => n + (b.kind === 'break' ? 0 : b.text.length), 0);
    if (chars === 0) throw new SourceRefusal(sniffed.format === 'PDF' ? 'SOURCE_NO_TEXT_LAYER' : 'SOURCE_EMPTY');
    if (chars > SOURCE_TEXT_MAX_CHARS) throw new SourceRefusal('SOURCE_TOO_LONG');
    return { format: sniffed.format, blocks };
}
