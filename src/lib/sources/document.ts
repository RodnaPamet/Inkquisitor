/**
 * A source as a run of BLOCKS (Phase 4.0): headings, paragraphs and scene or
 * chapter breaks, whatever format it came in. The chunker cuts along them.
 *
 *   HTML        (a DOCX through mammoth, an EPUB's XHTML) read with
 *               htmlparser2 — a real parser, never a tag-stripping pattern:
 *               `h1`–`h6` are headings, every other block element ends a
 *               paragraph, `hr` is a scene break, script-like elements are
 *               not text, entities are decoded once.
 *   Markdown    `#` headings, blank-line paragraphs, `***` / `---` breaks.
 *   Plain text  (a TXT, a PDF's pages) blank-line paragraphs; a line that is
 *               a chapter heading ("Chapter 3", "PART TWO", "Prologue") is a
 *               heading, a line of three stars or dashes a scene break.
 *
 * Pure. Text is plain (never HTML) and tidied (`tidyPlainText`).
 */
import { Parser } from 'htmlparser2';
import { tidyPlainText } from '@/lib/search/plain-text';

export type DocBlock =
    | { readonly kind: 'heading'; readonly level: number; readonly text: string }
    | { readonly kind: 'para'; readonly text: string }
    | { readonly kind: 'break'; readonly strength: 'scene' | 'chapter' };

const HEADINGS: Readonly<Record<string, number>> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const PARA_ELEMENTS: ReadonlySet<string> = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'header', 'li', 'main', 'nav', 'ol', 'p',
    'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'body',
]);
const NON_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title']);

/** Blocks from an HTML (or XHTML) document. */
export function blocksFromHtml(html: string): DocBlock[] {
    const blocks: DocBlock[] = [];
    let parts: string[] = [];
    let heading: number | null = null;
    let skipping = 0;
    const flush = () => {
        const text = tidyPlainText(parts.join('')).replace(/\n/g, ' ');
        parts = [];
        if (text === '') return;
        blocks.push(heading !== null ? { kind: 'heading', level: heading, text } : { kind: 'para', text });
    };
    const parser = new Parser(
        {
            onopentag(name) {
                if (NON_TEXT.has(name)) {
                    skipping++;
                    return;
                }
                if (name in HEADINGS) {
                    flush();
                    heading = HEADINGS[name];
                } else if (PARA_ELEMENTS.has(name)) flush();
                else if (name === 'br') parts.push(' ');
                else if (name === 'hr') {
                    flush();
                    blocks.push({ kind: 'break', strength: 'scene' });
                }
            },
            onclosetag(name) {
                if (NON_TEXT.has(name)) {
                    skipping = Math.max(0, skipping - 1);
                    return;
                }
                if (name in HEADINGS) {
                    flush();
                    heading = null;
                } else if (PARA_ELEMENTS.has(name)) flush();
            },
            ontext(text) {
                if (skipping === 0) parts.push(text);
            },
        },
        { decodeEntities: true, lowerCaseTags: true },
    );
    parser.parseComplete(html);
    flush();
    return blocks;
}

/** A line of only stars, dashes, tildes or hashes (spaces aside): a scene break. Checked without a nested quantifier. */
export function isBreakLine(line: string): boolean {
    const bare = line.replace(/\s/g, '');
    if (bare.length < 1 || bare.length > 40) return false;
    if (/^\*{3,}$/.test(bare) || /^-{3,}$/.test(bare) || /^~{3,}$/.test(bare) || /^_{3,}$/.test(bare)) return true;
    return bare === '#' || bare === '§';
}

const HEADING_WORDS = /^(?:chapter|part|book|prologue|epilogue|interlude|act|section)\b/i;

/** A short line that names a chapter: "Chapter 3", "CHAPTER THREE: The River", "Part Two", "Prologue". */
export function isChapterLine(line: string): boolean {
    const t = line.trim();
    if (t.length === 0 || t.length > 80) return false;
    return HEADING_WORDS.test(t) && !/[.!?,;]$/.test(t);
}

/** Blocks from plain text: blank-line paragraphs, chapter lines as headings, break lines as breaks. */
export function blocksFromPlainText(text: string): DocBlock[] {
    const blocks: DocBlock[] = [];
    let para: string[] = [];
    const flush = () => {
        const t = para.join(' ').replace(/[^\S\n]+/g, ' ').trim();
        para = [];
        if (t !== '') blocks.push({ kind: 'para', text: t });
    };
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.trim();
        if (line === '') {
            flush();
            continue;
        }
        if (isBreakLine(line)) {
            flush();
            blocks.push({ kind: 'break', strength: 'scene' });
            continue;
        }
        if (isChapterLine(line)) {
            flush();
            blocks.push({ kind: 'heading', level: 2, text: line });
            continue;
        }
        para.push(line);
    }
    flush();
    return blocks;
}

/** Blocks from Markdown: `#` headings, blank-line paragraphs, `***` / `---` breaks; everything else read as plain text. */
export function blocksFromMarkdown(text: string): DocBlock[] {
    const blocks: DocBlock[] = [];
    let para: string[] = [];
    const flush = () => {
        const t = para.join(' ').replace(/[^\S\n]+/g, ' ').trim();
        para = [];
        if (t !== '') blocks.push({ kind: 'para', text: t });
    };
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.trim();
        if (line === '') {
            flush();
            continue;
        }
        const hashes = /^(#{1,6})\s/.exec(line);
        if (hashes) {
            flush();
            const title = line.slice(hashes[1].length).trim();
            if (title !== '') blocks.push({ kind: 'heading', level: hashes[1].length, text: title });
            continue;
        }
        if (isBreakLine(line)) {
            flush();
            blocks.push({ kind: 'break', strength: 'scene' });
            continue;
        }
        para.push(line);
    }
    flush();
    return blocks;
}

/** The document's text as the chunker lays it out: blocks joined by blank lines, breaks omitted. */
export function blocksText(blocks: readonly DocBlock[]): string {
    return blocks
        .filter((b): b is Exclude<DocBlock, { kind: 'break' }> => b.kind !== 'break')
        .map((b) => b.text)
        .join('\n\n');
}
