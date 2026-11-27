/**
 * The manuscript as files (Phase 5.H-a, D36 and the D33 addendum: "the manuscript in the export"): a DOCX that any
 * word processor opens, and Markdown. Both are functions of the manuscript alone — no time, no id, fixed zip dates —
 * so the same manuscript exports to the same bytes. Server-only (the blocks come from htmlparser2).
 *
 * THE DOCX is the smallest WordprocessingML package Word, LibreOffice and mammoth read: the content types, the two
 * relationship parts, the core properties (the book's title), the styles (Title, Heading 1–3, Quote, Normal) and the
 * document. A part is a Heading 1 (none when the manuscript is one untitled part), a chapter a Heading 2 (an untitled
 * one "Chapter N"), a titled scene a Heading 3, and untitled scenes are parted by a centred "* * *". Bold, italic,
 * underline and strike-through runs, line breaks, quoted paragraphs and list items are kept (a list item is a
 * paragraph with its bullet or number written out). Every string is XML-escaped, and characters XML 1.0 cannot hold
 * are dropped (the stored text strips control characters already; a lone surrogate is the remaining case).
 *
 * THE MARKDOWN is CommonMark: `#` headings, `*italic*`, `**bold**`, `~~strike~~` (underline has no Markdown and is
 * kept as plain text), `>` quotes, `-` and `1.` items, `* * *` between untitled scenes and for a rule, a hard line
 * break as a trailing backslash. Characters Markdown would read as markup are escaped.
 */
import { writeZip } from '@/lib/archive/zip';
import type { SceneBlock, SceneRun } from '@/lib/manuscript/scene-blocks';

export interface ExportScene {
    title: string | null;
    blocks: SceneBlock[];
}
export interface ExportChapter {
    title: string | null;
    scenes: ExportScene[];
}
export interface ExportPart {
    title: string | null;
    chapters: ExportChapter[];
}
export interface ExportManuscript {
    bookTitle: string;
    /** One untitled part: no part headings (the outline shows no part level either). */
    singleDefaultPart: boolean;
    parts: ExportPart[];
}

// ─── XML ────────────────────────────────────────────────────────────

/** Characters XML 1.0 cannot carry (C0 controls but tab, LF and CR; U+FFFE/U+FFFF; a lone surrogate). */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xmlText(text: string): string {
    return text.replace(XML_INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function runXml(run: SceneRun): string {
    const props = [run.bold ? '<w:b/>' : '', run.italic ? '<w:i/>' : '', run.underline ? '<w:u w:val="single"/>' : '', run.strike ? '<w:strike/>' : ''].join('');
    const rPr = props === '' ? '' : `<w:rPr>${props}</w:rPr>`;
    const pieces = run.text.split('\n').map((t) => (t === '' ? '' : `<w:t xml:space="preserve">${xmlText(t)}</w:t>`));
    return `<w:r>${rPr}${pieces.join('<w:br/>')}</w:r>`;
}

function paragraphXml(style: string | null, runs: readonly SceneRun[], opts: { center?: boolean } = {}): string {
    const pPr = style || opts.center ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${opts.center ? '<w:jc w:val="center"/>' : ''}</w:pPr>` : '';
    return `<w:p>${pPr}${runs.map(runXml).join('')}</w:p>`;
}

const plain = (text: string): SceneRun => ({ text, bold: false, italic: false, underline: false, strike: false });
const SEPARATOR = '* * *';

function blockXml(block: SceneBlock, number: number): string {
    switch (block.kind) {
        case 'rule':
            return paragraphXml(null, [plain(SEPARATOR)], { center: true });
        case 'quote':
            return paragraphXml('Quote', block.runs);
        case 'bullet':
            return paragraphXml(null, [plain('• '), ...block.runs]);
        case 'number':
            return paragraphXml(null, [plain(`${number}. `), ...block.runs]);
        default:
            return paragraphXml(null, block.runs);
    }
}

/** Walk the manuscript in order: what a heading or separator goes where, shared by the two writers. */
function* outline(m: ExportManuscript): Generator<
    | { kind: 'part'; title: string }
    | { kind: 'chapter'; title: string }
    | { kind: 'scene'; title: string | null; separate: boolean; scene: ExportScene }
> {
    let chapterNumber = 0;
    for (const [pi, part] of m.parts.entries()) {
        if (!m.singleDefaultPart) yield { kind: 'part', title: part.title ?? `Part ${pi + 1}` };
        for (const chapter of part.chapters) {
            chapterNumber++;
            yield { kind: 'chapter', title: chapter.title ?? `Chapter ${chapterNumber}` };
            for (const [si, scene] of chapter.scenes.entries()) {
                yield { kind: 'scene', title: scene.title, separate: si > 0 && scene.title === null, scene };
            }
        }
    }
}

/** Number each run of numbered items from 1 (a list's items are consecutive blocks of kind `number`). */
function numbered(blocks: readonly SceneBlock[]): number[] {
    let n = 0;
    return blocks.map((b) => (b.kind === 'number' ? ++n : (n = 0)));
}

function documentXml(m: ExportManuscript): string {
    const body: string[] = [paragraphXml('Title', [plain(m.bookTitle)])];
    for (const item of outline(m)) {
        if (item.kind === 'part') body.push(paragraphXml('Heading1', [plain(item.title)]));
        else if (item.kind === 'chapter') body.push(paragraphXml('Heading2', [plain(item.title)]));
        else {
            if (item.separate) body.push(paragraphXml(null, [plain(SEPARATOR)], { center: true }));
            if (item.title !== null) body.push(paragraphXml('Heading3', [plain(item.title)]));
            const numbers = numbered(item.scene.blocks);
            item.scene.blocks.forEach((b, i) => body.push(blockXml(b, numbers[i])));
        }
    }
    return `${XML_HEAD}<w:document xmlns:w="${W_NS}"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const STYLES_XML = `${XML_HEAD}<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`;

const CONTENT_TYPES_XML = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
const ROOT_RELS_XML = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
const DOCUMENT_RELS_XML = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

function coreXml(title: string): string {
    return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlText(title)}</dc:title></cp:coreProperties>`;
}

/** The manuscript as a .docx file's bytes (deterministic). */
export function manuscriptDocx(m: ExportManuscript): Uint8Array {
    return writeZip(
        new Map<string, string>([
            ['[Content_Types].xml', CONTENT_TYPES_XML],
            ['_rels/.rels', ROOT_RELS_XML],
            ['docProps/core.xml', coreXml(m.bookTitle)],
            ['word/_rels/document.xml.rels', DOCUMENT_RELS_XML],
            ['word/styles.xml', STYLES_XML],
            ['word/document.xml', documentXml(m)],
        ]),
    );
}

// ─── Markdown ───────────────────────────────────────────────────────

/** Characters CommonMark could read as markup inside a line, each escaped with a backslash. */
const MD_SPECIAL = /[\\`*_[\]{}<>#+\-!|~]/g;

export function markdownText(text: string): string {
    return text.replace(MD_SPECIAL, (c) => `\\${c}`);
}

function runMarkdown(run: SceneRun): string {
    // Marks wrap only the non-space core of a run: CommonMark refuses `* word*`.
    return run.text
        .split('\n')
        .map((line) => {
            const core = line.trim();
            const lead = line.slice(0, line.length - line.trimStart().length);
            const trail = core === '' ? '' : line.slice(line.trimEnd().length);
            if (core === '') return line;
            let md = markdownText(core);
            if (run.strike) md = `~~${md}~~`;
            if (run.italic) md = `*${md}*`;
            if (run.bold) md = `**${md}**`;
            return lead + md + trail;
        })
        .join('\\\n');
}

function blockMarkdown(block: SceneBlock, number: number): string {
    const text = block.runs.map(runMarkdown).join('');
    switch (block.kind) {
        case 'rule':
            return SEPARATOR;
        case 'quote':
            return text
                .split('\n')
                .map((l) => `> ${l}`)
                .join('\n');
        case 'bullet':
            return `- ${text}`;
        case 'number':
            return `${number}. ${text}`;
        default:
            return text;
    }
}

/** The manuscript as Markdown (deterministic; a trailing newline). */
export function manuscriptMarkdown(m: ExportManuscript): string {
    const out: string[] = [`# ${markdownText(m.bookTitle)}`];
    const level = m.singleDefaultPart ? 0 : 1;
    for (const item of outline(m)) {
        if (item.kind === 'part') out.push(`## ${markdownText(item.title)}`);
        else if (item.kind === 'chapter') out.push(`${'#'.repeat(2 + level)} ${markdownText(item.title)}`);
        else {
            if (item.separate) out.push(SEPARATOR);
            if (item.title !== null) out.push(`${'#'.repeat(3 + level)} ${markdownText(item.title)}`);
            const numbers = numbered(item.scene.blocks);
            item.scene.blocks.forEach((b, i) => out.push(blockMarkdown(b, numbers[i])));
        }
    }
    return `${out.join('\n\n')}\n`;
}
